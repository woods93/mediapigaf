// Artist-facing API. Every call carries the invite token in "Authorization: Bearer <token>".

import { validateAndLookup } from "./lookup.js";
import { renderUploadPage } from "./uploadpage.js";
import { CHUNK_BYTES, FILE_KINDS, actionItems, checkFile, validateSong } from "./validate.js";
import { HttpError, html, json, nowIso, randomId, readJson, safeName, sha256Hex, slug } from "./util.js";

const INVALID = "This link isn't valid, has expired, or was cancelled. Please ask for a new one.";

async function authInvite(req, env) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,64})$/.exec(req.headers.get("Authorization") || "");
  if (!m) throw new HttpError(401, INVALID);
  const hash = await sha256Hex(m[1]);
  const inv = await env.DB.prepare("SELECT * FROM invites WHERE token_hash = ?").bind(hash).first();
  if (!inv || inv.revoked_at || inv.expires_at <= nowIso()) throw new HttpError(401, INVALID);
  return inv;
}

async function ownSong(env, inv, id, { draftOnly = true } = {}) {
  const s = await env.DB.prepare("SELECT * FROM songs WHERE id = ? AND invite_id = ?").bind(id, inv.id).first();
  if (!s) throw new HttpError(404, "Song not found.");
  if (draftOnly && s.status !== "draft") throw new HttpError(409, "This song was already submitted and can't be changed here.");
  return s;
}

async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;   // not configured: skip
  if (!token) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (ip) form.set("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  return !!j.success;
}

async function loadParts(env, songId) {
  const q = (t) => env.DB.prepare(`SELECT * FROM ${t} WHERE song_id = ? ORDER BY position`).bind(songId).all().then(r => r.results);
  const [writers, publishers] = await Promise.all([q("writers"), q("publishers")]);
  const files = (await env.DB.prepare("SELECT * FROM files WHERE song_id = ?").bind(songId).all()).results;
  return { writers, publishers, files };
}

async function dropObject(env, f) {
  try {
    if (f.status === "uploading" && f.upload_id) await env.BUCKET.resumeMultipartUpload(f.r2_key, f.upload_id).abort();
    else await env.BUCKET.delete(f.r2_key);
  } catch { /* already gone */ }
}

export async function handleUpload(req, env, url) {
  const p = url.pathname, method = req.method;

  if (method === "GET" && p === "/upload") {
    return html(renderUploadPage({ sitekey: env.TURNSTILE_SITEKEY || "" }), 200, env.TURNSTILE_SITEKEY ? { script: ["https://challenges.cloudflare.com"], frame: ["https://challenges.cloudflare.com"] } : {});
  }
  if (!p.startsWith("/api/")) return null;

  const inv = await authInvite(req, env);

  if (method === "GET" && p === "/api/invite") {
    return json({ artist_name: inv.artist_name, expires_at: inv.expires_at, songs_left: Math.max(0, inv.max_uses - inv.use_count), max_file_mb: 100 });
  }

  if (method === "POST" && p === "/api/lookup") {
    const hour = new Date(Date.now() - 3600_000).toISOString();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM lookups WHERE invite_id = ? AND fetched_at > ?").bind(inv.id, hour).first();
    if (n.n >= 60) throw new HttpError(429, "That's a lot of lookups in an hour. Please try again later, or just fill in the form.");
    const body = await readJson(req, 5_000);
    const out = await validateAndLookup(env, { isrc: body.isrc, artist: body.artist, title: body.title, source: "auto" });
    if (out.status === 200) {
      const rj = JSON.stringify(out.body).slice(0, 150_000);
      await env.DB.prepare("INSERT INTO lookups (id, invite_id, query, result_json, fetched_at) VALUES (?,?,?,?,?)")
        .bind(randomId(), inv.id, JSON.stringify({ isrc: body.isrc || "", artist: body.artist || "", title: body.title || "" }), rj, nowIso()).run();
    }
    return json(out.body, out.status);
  }

  if (method === "POST" && p === "/api/songs") {
    if (inv.use_count >= inv.max_uses) throw new HttpError(429, "This link has reached its limit of songs.");
    const body = await readJson(req);
    if (!(await turnstileOk(env, body.turnstile, req.headers.get("CF-Connecting-IP")))) throw new HttpError(403, "The human check didn't pass. Please reload and try again.");
    const { errors, clean: c } = validateSong(body);
    if (errors.length) return json({ errors }, 422);
    const id = randomId(), now = nowIso();
    const stmts = [
      env.DB.prepare("INSERT INTO songs (id, invite_id, title, artist, isrc, iswc, mlc_song_code, pro, pro_work_code, self_published, notes, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, inv.id, c.title, c.artist, c.isrc || null, c.iswc || null, c.mlc_song_code || null, c.pro || null, c.pro_work_code || null, c.self_published, c.notes || null, "draft", now, now),
      ...c.writers.map((w, n) => env.DB.prepare("INSERT INTO writers (id, song_id, position, name, ipi, pro, role, share_pct) VALUES (?,?,?,?,?,?,?,?)")
        .bind(randomId(), id, n, w.name, w.ipi || null, w.pro || null, w.role || null, w.share_pct)),
      ...c.publishers.map((w, n) => env.DB.prepare("INSERT INTO publishers (id, song_id, position, name, ipi, pro, share_pct) VALUES (?,?,?,?,?,?,?)")
        .bind(randomId(), id, n, w.name, w.ipi || null, w.pro || null, w.share_pct)),
      env.DB.prepare("UPDATE lookups SET song_id = ? WHERE invite_id = ? AND song_id IS NULL").bind(id, inv.id),
      env.DB.prepare("UPDATE invites SET use_count = use_count + 1, last_used_at = ? WHERE id = ?").bind(now, inv.id),
      env.DB.prepare("INSERT INTO status_log (id, song_id, status, note, by_who, at) VALUES (?,?,?,?,?,?)").bind(randomId(), id, "draft", "Created from invite", inv.artist_name, now),
    ];
    await env.DB.batch(stmts);
    return json({ id }, 201);
  }

  const m = /^\/api\/songs\/([a-z2-7]{16})(?:\/(files|submit)(?:\/([a-z2-7]{16})(?:\/(parts\/(\d{1,4})|complete))?)?)?$/.exec(p);
  if (!m) throw new HttpError(404, "Not found.");
  const [, songId, area, fileId, , partNo] = m;
  const sub = m[4];

  if (area === "submit" && method === "POST") {
    const s = await ownSong(env, inv, songId);
    let { writers, publishers, files } = await loadParts(env, songId);
    // The form only submits after every upload finishes, so anything still "uploading" was abandoned (closed tab, lost signal). Clean it up rather than block the artist.
    for (const f of files.filter(x => x.status === "uploading")) {
      await dropObject(env, f);
      await env.DB.prepare("UPDATE files SET status = 'abandoned', upload_id = NULL WHERE id = ?").bind(f.id).run();
    }
    files = files.filter(f => f.status !== "abandoned" && f.status !== "uploading");
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("UPDATE songs SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ?").bind(now, now, songId),
      env.DB.prepare("INSERT INTO status_log (id, song_id, status, note, by_who, at) VALUES (?,?,?,?,?,?)").bind(randomId(), songId, "submitted", null, inv.artist_name, now),
    ]);
    return json({ ok: true, items: actionItems(s, writers, publishers, files) });
  }

  if (area === "files" && !fileId && method === "POST") {
    const s = await ownSong(env, inv, songId);
    const body = await readJson(req, 5_000);
    const kind = String(body.kind || ""), name = String(body.name || ""), size = Number(body.size);
    if (!FILE_KINDS[kind]) throw new HttpError(400, "Unknown file slot.");
    const chk = checkFile(kind, name, size);
    if (!chk.ok) throw new HttpError(400, chk.error);
    // One file per slot: a new upload replaces the old one.
    const olds = (await env.DB.prepare("SELECT * FROM files WHERE song_id = ? AND kind = ? AND status IN ('uploading','ready')").bind(songId, kind).all()).results;
    for (const o of olds) { await dropObject(env, o); await env.DB.prepare("UPDATE files SET status = 'replaced' WHERE id = ?").bind(o.id).run(); }
    const fid = randomId(), key = `artists/${slug(inv.artist_name)}/${s.id}/${kind}/${fid}-${safeName(name)}`;
    const mp = await env.BUCKET.createMultipartUpload(key);
    await env.DB.prepare("INSERT INTO files (id, song_id, kind, orig_name, r2_key, declared_bytes, upload_id, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(fid, songId, kind, name.slice(0, 200), key, size, mp.uploadId, "uploading", nowIso()).run();
    return json({ file_id: fid, chunk_bytes: CHUNK_BYTES, parts: Math.ceil(size / CHUNK_BYTES) }, 201);
  }

  if (area === "files" && fileId) {
    await ownSong(env, inv, songId);
    const f = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND song_id = ?").bind(fileId, songId).first();
    if (!f) throw new HttpError(404, "File not found.");
    if (f.status !== "uploading") throw new HttpError(409, "That upload isn't active.");
    const total = Math.ceil(f.declared_bytes / CHUNK_BYTES);

    if (partNo && method === "PUT") {
      const n = Number(partNo);
      if (n < 1 || n > total) throw new HttpError(400, "Bad part number.");
      const expected = n < total ? CHUNK_BYTES : f.declared_bytes - (total - 1) * CHUNK_BYTES;
      const cl = Number(req.headers.get("content-length") || -1);
      if (cl !== expected) throw new HttpError(400, "That chunk isn't the expected size.");
      const buf = await req.arrayBuffer();
      if (buf.byteLength !== expected) throw new HttpError(400, "That chunk isn't the expected size.");
      if (n === 1) {
        const chk = checkFile(f.kind, f.orig_name, f.declared_bytes, new Uint8Array(buf, 0, Math.min(32, buf.byteLength)));
        if (!chk.ok) {
          await dropObject(env, f);
          await env.DB.prepare("UPDATE files SET status = 'rejected' WHERE id = ?").bind(f.id).run();
          throw new HttpError(415, chk.error);
        }
        await env.DB.prepare("UPDATE files SET detected = ? WHERE id = ?").bind(chk.detected, f.id).run();
      }
      const part = await env.BUCKET.resumeMultipartUpload(f.r2_key, f.upload_id).uploadPart(n, buf);
      const parts = JSON.parse(f.parts_json).filter(x => x.partNumber !== n);
      parts.push({ partNumber: part.partNumber, etag: part.etag });
      await env.DB.prepare("UPDATE files SET parts_json = ? WHERE id = ?").bind(JSON.stringify(parts), f.id).run();
      return json({ ok: true, part: n, of: total });
    }

    if (sub === "complete" && method === "POST") {
      const parts = JSON.parse(f.parts_json).sort((a, b) => a.partNumber - b.partNumber);
      if (parts.length !== total || parts.some((x, i) => x.partNumber !== i + 1)) throw new HttpError(400, "Some parts are missing. Please retry the upload.");
      const obj = await env.BUCKET.resumeMultipartUpload(f.r2_key, f.upload_id).complete(parts);
      if (obj.size !== f.declared_bytes) {
        await env.BUCKET.delete(f.r2_key);
        await env.DB.prepare("UPDATE files SET status = 'rejected' WHERE id = ?").bind(f.id).run();
        throw new HttpError(400, "The stored file didn't match its size. Please try again.");
      }
      await env.DB.prepare("UPDATE files SET status = 'ready', bytes = ?, etag = ?, verified_at = ?, upload_id = NULL WHERE id = ?").bind(obj.size, obj.etag || null, nowIso(), f.id).run();
      return json({ ok: true, bytes: obj.size, detected: f.detected });
    }
  }
  throw new HttpError(404, "Not found.");
}
