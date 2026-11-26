// Admin: protected by Cloudflare Access. Fails closed: with no Access settings, nothing is served.

import adminPage from "../pages/admin.html";
import { STATUSES, actionItems } from "./validate.js";
import { HttpError, SEC_HEADERS, html, json, newToken, nowIso, randomId, readJson, safeName, sha256Hex } from "./util.js";

// ---- Cloudflare Access JWT check ---------------------------------------------------------------------------

let jwks = { keys: null, at: 0, team: "" };

const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));
const parseJ = s => JSON.parse(new TextDecoder().decode(b64u(s)));

async function accessKeys(team) {
  if (jwks.keys && jwks.team === team && Date.now() - jwks.at < 3600_000) return jwks.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new HttpError(503, "Couldn't reach Cloudflare Access to check your sign-in.");
  jwks = { keys: (await r.json()).keys || [], at: Date.now(), team };
  return jwks.keys;
}

export async function adminAuth(req, env, url) {
  if (env.ADMIN_DEV_BYPASS === "1" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return { email: "dev@localhost" };
  const team = env.ACCESS_TEAM_DOMAIN || "", aud = env.ACCESS_AUD || "";
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !aud) throw new HttpError(503, "The admin area isn't switched on yet. Cloudflare Access still needs to be set up for it.");
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion") || "";
  const [h, p, s] = jwt.split(".");
  if (!s) throw new HttpError(403, "Sign-in required.");
  try {
    const header = parseJ(h), payload = parseJ(p);
    if (header.alg !== "RS256") throw new Error("alg");
    const jwk = (await accessKeys(team)).find(k => k.kid === header.kid);
    if (!jwk) throw new Error("kid");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(`${h}.${p}`));
    const now = Date.now() / 1000;
    const audOk = [].concat(payload.aud || []).includes(aud);
    if (!ok || !audOk || payload.iss !== `https://${team}` || !(payload.exp > now) || (payload.nbf && payload.nbf > now + 60)) throw new Error("claims");
    return { email: String(payload.email || "admin") };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(403, "Sign-in required.");
  }
}

// ---- Routes ------------------------------------------------------------------------------------------------

const MIME = { pdf: "application/pdf", png: "image/png", jpeg: "image/jpeg", wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", aiff: "audio/aiff" };

async function songParts(env, ids) {
  if (!ids.length) return { writers: [], publishers: [], files: [] };
  const q = t => env.DB.prepare(`SELECT * FROM ${t} WHERE song_id IN (${ids.map(() => "?").join(",")}) ORDER BY position`).bind(...ids).all().then(r => r.results);
  const [writers, publishers] = await Promise.all([q("writers"), q("publishers")]);
  const files = (await env.DB.prepare(`SELECT * FROM files WHERE song_id IN (${ids.map(() => "?").join(",")}) AND status NOT IN ('replaced','abandoned')`).bind(...ids).all()).results;
  return { writers, publishers, files };
}
const by = (rows, id) => rows.filter(r => r.song_id === id);

export async function handleAdmin(req, env, url) {
  const p = url.pathname, method = req.method;
  const who = await adminAuth(req, env, url);

  if (method === "GET" && (p === "/admin" || p === "/admin/")) return html(adminPage);

  if (method === "GET" && /^\/admin\/files\/[a-z2-7]{16}$/.test(p)) {
    const f = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND status = 'ready'").bind(p.split("/").pop()).first();
    if (!f) throw new HttpError(404, "File not found.");
    const obj = await env.BUCKET.get(f.r2_key, { range: req.headers });
    if (!obj) throw new HttpError(404, "File not found.");
    const h = new Headers(SEC_HEADERS);
    h.set("Content-Type", MIME[f.detected] || "application/octet-stream");
    h.set("Content-Disposition", `attachment; filename="${safeName(f.orig_name)}"`);
    h.set("Content-Security-Policy", "sandbox; default-src 'none'");
    h.set("Accept-Ranges", "bytes");
    h.set("Cache-Control", "private, no-store");
    let status = 200;
    if (obj.range && req.headers.has("Range")) {   // R2 may report a range even for a whole-object read
      const r = obj.range, off = r.suffix != null ? obj.size - r.suffix : (r.offset || 0), len = r.suffix != null ? r.suffix : (r.length ?? obj.size - off);
      h.set("Content-Range", `bytes ${off}-${off + len - 1}/${obj.size}`);
      h.set("Content-Length", String(len));
      status = 206;
    } else h.set("Content-Length", String(obj.size));
    return new Response(obj.body, { status, headers: h });
  }

  if (!p.startsWith("/admin/api/")) throw new HttpError(404, "Not found.");
  if (method !== "GET") {
    // Cookie-based sign-in means a hostile page could try to POST here. A custom header can't be sent cross-site without CORS approval, which we never give.
    if (req.headers.get("X-Admin") !== "1" || !(req.headers.get("Content-Type") || "").includes("application/json")) throw new HttpError(403, "Bad request.");
  }

  if (method === "GET" && p === "/admin/api/me") return json({ email: who.email });

  if (method === "GET" && p === "/admin/api/invites") {
    const rows = (await env.DB.prepare("SELECT i.*, (SELECT COUNT(*) FROM songs s WHERE s.invite_id = i.id AND s.status != 'draft') AS submitted FROM invites i ORDER BY i.created_at DESC LIMIT 300").all()).results;
    const now = nowIso();
    return json(rows.map(({ token_hash, ...r }) => ({ ...r, state: r.revoked_at ? "revoked" : r.expires_at <= now ? "expired" : r.use_count >= r.max_uses ? "full" : "active" })));
  }

  if (method === "POST" && p === "/admin/api/invites") {
    const b = await readJson(req, 5_000);
    const name = String(b.artist_name || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 100);
    if (!name) throw new HttpError(400, "Artist name is required.");
    const days = Math.min(90, Math.max(1, Math.floor(Number(b.days) || 14)));
    const maxUses = Math.min(100, Math.max(1, Math.floor(Number(b.max_uses) || 20)));
    const token = newToken(), id = randomId(), now = new Date();
    const expires = new Date(now.getTime() + days * 86400_000).toISOString();
    await env.DB.prepare("INSERT INTO invites (id, artist_name, token_hash, created_at, created_by, expires_at, max_uses) VALUES (?,?,?,?,?,?,?)")
      .bind(id, name, await sha256Hex(token), now.toISOString(), who.email, expires, maxUses).run();
    return json({ id, artist_name: name, expires_at: expires, link: `${url.origin}/upload?t=${token}` }, 201);
  }

  let m = /^\/admin\/api\/invites\/([a-z2-7]{16})\/revoke$/.exec(p);
  if (method === "POST" && m) {
    await env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowIso(), m[1]).run();
    return json({ ok: true });
  }

  if (method === "GET" && p === "/admin/api/songs") {
    const songs = (await env.DB.prepare("SELECT s.*, i.artist_name AS invite_artist FROM songs s JOIN invites i ON i.id = s.invite_id ORDER BY COALESCE(s.submitted_at, s.created_at) DESC LIMIT 500").all()).results;
    const parts = await songParts(env, songs.map(s => s.id));
    return json(songs.map(s => {
      const items = actionItems(s, by(parts.writers, s.id), by(parts.publishers, s.id), by(parts.files, s.id));
      return { id: s.id, title: s.title, artist: s.artist, isrc: s.isrc, status: s.status, invite_artist: s.invite_artist, created_at: s.created_at, submitted_at: s.submitted_at,
        needed: items.filter(i => i.level === "needed").length, recommended: items.filter(i => i.level === "recommended").length };
    }));
  }

  m = /^\/admin\/api\/songs\/([a-z2-7]{16})$/.exec(p);
  if (method === "GET" && m) {
    const s = await env.DB.prepare("SELECT s.*, i.artist_name AS invite_artist FROM songs s JOIN invites i ON i.id = s.invite_id WHERE s.id = ?").bind(m[1]).first();
    if (!s) throw new HttpError(404, "Song not found.");
    const parts = await songParts(env, [s.id]);
    const log = (await env.DB.prepare("SELECT status, note, by_who, at FROM status_log WHERE song_id = ? ORDER BY at").bind(s.id).all()).results;
    const lookups = (await env.DB.prepare("SELECT query, result_json, fetched_at FROM lookups WHERE song_id = ? ORDER BY fetched_at").bind(s.id).all()).results
      .map(l => { let r = {}; try { r = JSON.parse(l.result_json); } catch { /* keep empty */ } return { query: l.query, fetched_at: l.fetched_at, trail: r.trail || [], works: r.works || [], recordings: r.recordings || [] }; });
    return json({ song: s, writers: parts.writers, publishers: parts.publishers, files: parts.files.map(({ r2_key, upload_id, parts_json, ...f }) => f),
      items: actionItems(s, parts.writers, parts.publishers, parts.files), log, lookups });
  }

  m = /^\/admin\/api\/songs\/([a-z2-7]{16})\/status$/.exec(p);
  if (method === "POST" && m) {
    const b = await readJson(req, 10_000);
    if (!STATUSES.includes(b.status)) throw new HttpError(400, "Unknown status.");
    const note = String(b.note || "").slice(0, 2000) || null, now = nowIso();
    const res = await env.DB.batch([
      env.DB.prepare("UPDATE songs SET status = ?, admin_notes = COALESCE(?, admin_notes), updated_at = ? WHERE id = ?").bind(b.status, b.admin_notes == null ? null : String(b.admin_notes).slice(0, 5000), now, m[1]),
      env.DB.prepare("INSERT INTO status_log (id, song_id, status, note, by_who, at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM songs WHERE id = ?)").bind(randomId(), m[1], b.status, note, who.email, now, m[1]),
    ]);
    if (!res[0].meta.changes) throw new HttpError(404, "Song not found.");
    return json({ ok: true });
  }

  m = /^\/admin\/api\/songs\/([a-z2-7]{16})\/delete$/.exec(p);
  if (method === "POST" && m) {
    const files = (await env.DB.prepare("SELECT * FROM files WHERE song_id = ?").bind(m[1]).all()).results;
    for (const f of files) {
      try { if (f.status === "uploading" && f.upload_id) await env.BUCKET.resumeMultipartUpload(f.r2_key, f.upload_id).abort(); else await env.BUCKET.delete(f.r2_key); } catch { /* already gone */ }
    }
    await env.DB.prepare("DELETE FROM songs WHERE id = ?").bind(m[1]).run();   // rows in the other tables go with it (ON DELETE CASCADE)
    return json({ ok: true });
  }

  throw new HttpError(404, "Not found.");
}
