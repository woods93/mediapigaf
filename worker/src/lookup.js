// MLC lookup test: one Cloudflare Worker serving the form (GET /) and the lookup (POST /lookup).
// Secrets: MLC_USER, MLC_PASS.  Variable: DEMO = "1" for fake sample data (no MLC login needed).

const API = "https://public-api.themlc.com";
let cached = { token: null, exp: 0 };

const DEMO_DATA = {
  demo: true,
  recordings: [{ id: "demo-1", mlcsongCode: "DEMO123", title: "Sample Song", artist: "Sample Artist", isrc: "USXXX2600001", labels: ["Sample Label"] }],
  works: [{
    primaryTitle: "SAMPLE SONG", artists: ["Sample Artist"], iswc: "T-000.000.001-0", mlcSongCode: "DEMO123",
    akas: [{ akaTitle: "Sample Song (Alt)", akaTitleTypeCode: "AT" }],
    writers: [{ writerFirstName: "Pat", writerLastName: "Writer", writerIPI: "00000000001", writerRoleCode: "CA" }],
    publishers: [{ publisherName: "Sample Publishing", publisherIpiNumber: "00000000002", mlcPublisherNumber: "P0001", collectionShare: 100, administrators: [], parentPublishers: [] }]
  }]
};

async function getToken(env) {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const r = await fetch(`${API}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: env.MLC_USER, password: env.MLC_PASS }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.accessToken) throw new Error(`MLC login failed (${r.status}): ${j.errorDescription || j.error || "no detail"}`);
  cached = { token: j.accessToken, exp: Date.now() + Math.max(60, (j.expiresIn || 300) - 60) * 1000 };
  return cached.token;
}

async function mlc(env, path, body) {
  const token = await getToken(env);
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`MLC ${path} returned ${r.status}: ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// ---- MusicBrainz (no login). Free API, CC0 data, limit 1 request/second, needs a descriptive User-Agent.
const MB = "https://musicbrainz.org/ws/2";
const MB_UA = "MediaPigAF-lookup-test/0.1 (https://mediapigaf.com)";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastMB = 0;

// One MusicBrainz call: paced at ~1/second, and on 503/429 ("busy, slow down") it waits and retries up to 3 times.
async function mb(path) {
  const sep = path.includes("?") ? "&" : "?";
  let status = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastMB + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastMB = Date.now();
    const r = await fetch(`${MB}${path}${sep}fmt=json`, { headers: { "User-Agent": MB_UA, Accept: "application/json" } });
    status = r.status;
    if (r.status === 404) return null;
    if (r.ok) return r.json();
    if (r.status !== 503 && r.status !== 429) break;
    const ra = parseInt(r.headers.get("Retry-After") || "", 10);
    await sleep(Math.min(8000, (ra > 0 ? ra * 1000 : 2000 * (attempt + 1))));
  }
  throw new Error(`MusicBrainz ${path.split("?")[0].replace(/[0-9a-f-]{36}/, "{id}")} returned ${status}`);
}

async function lookupMB({ isrc, artist, title }) {
  let recs = [];
  if (isrc) {
    const j = await mb(`/isrc/${encodeURIComponent(isrc.trim().toUpperCase().replace(/[^A-Z0-9]/g, ""))}?inc=artist-credits`);
    recs = (j && j.recordings) || [];
  } else {
    const q = `recording:"${String(title).replace(/"/g, "")}" AND artist:"${String(artist).replace(/"/g, "")}"`;
    const j = await mb(`/recording?query=${encodeURIComponent(q)}&limit=5`);
    recs = (j && j.recordings) || [];
  }
  recs = recs.slice(0, 2);   // fewer recordings means fewer calls (each call costs about a second)
  const warnings = [];
  const recordings = recs.map(r => ({
    id: r.id, title: r.title, isrc: isrc || "",
    artist: (r["artist-credit"] || []).map(a => (a.name || "") + (a.joinphrase || "")).join(""),
    labels: [],
  }));

  const works = [], seen = new Set();
  for (const r of recs) {
    if (works.length) break;   // one work is enough; stop early to stay under MusicBrainz's limits
    let full;
    try { full = await mb(`/recording/${r.id}?inc=work-rels`); }
    catch (e) { warnings.push(String(e.message || e)); continue; }
    for (const rel of (full && full.relations) || []) {
      const w = rel.work;
      if (!w || seen.has(w.id)) continue;
      seen.add(w.id);
      let wf;
      try { wf = await mb(`/work/${w.id}?inc=artist-rels`); }
      catch (e) { warnings.push(String(e.message || e)); continue; }
      const writers = [];
      for (const wr of ((wf && wf.relations) || [])) {
        if (!wr.artist || !["composer", "lyricist", "writer"].includes(wr.type)) continue;
        if (writers.some(x => x.writerId === wr.artist.id)) {
          const ex = writers.find(x => x.writerId === wr.artist.id);
          if (!ex.writerRoleCode.includes(wr.type)) ex.writerRoleCode += " + " + wr.type;
          continue;
        }
        writers.push({ writerId: wr.artist.id, writerName: wr.artist.name, writerIPI: "", writerRoleCode: wr.type });
      }
      // IPIs live on the artist record; fetch for up to 4 writers (adds ~1 second each).
      for (const wtr of writers.slice(0, 4)) {
        try {
          const a = await mb(`/artist/${wtr.writerId}`);
          if (a && a.ipis && a.ipis.length) wtr.writerIPI = a.ipis.join(", ");
        } catch (e) { warnings.push(`IPI for ${wtr.writerName} not retrieved (${String(e.message || e)})`); }
      }
      works.push({
        primaryTitle: (wf && wf.title) || w.title, artists: [recordings[0] && recordings[0].artist].filter(Boolean),
        iswc: ((wf && wf.iswcs) || w.iswcs || [])[0] || "", mlcSongCode: "",
        akas: [], writers, publishers: [],
      });
    }
  }
  return { demo: false, source: "musicbrainz", recordings, works, warnings };
}

// ---- credits.fm: free, CC-BY 4.0. Songwriter and publisher data comes from The MLC.
// Public endpoint is api.credits.fm/v1 (the /api/... paths on credits.fm are internal). 15 lookups/minute per IP
// without a key; a free key (secret CREDITS_KEY, sent as x-api-key) raises that to 300.
const CFM = "https://api.credits.fm/v1";
const clean = s => String(s || "").replace(/"/g, "").trim();

async function creditsByIsrc(env, isrc) {
  const headers = { Accept: "application/json", "User-Agent": MB_UA };
  if (env.CREDITS_KEY) headers["x-api-key"] = env.CREDITS_KEY;
  const r = await fetch(`${CFM}/isrc/${encodeURIComponent(isrc)}?contribute=false`, { headers });
  if (r.status === 404) return { found: false, note: "not found" };
  if (r.status === 429) return { found: false, note: "rate limited (15 lookups per minute without an API key)" };
  if (!r.ok) return { found: false, note: `unavailable (HTTP ${r.status})` };
  return { found: true, data: await r.json() };
}

function creditsToWork(j) {
  const ROLE = {
    E: "Original publisher", SE: "Sub-publisher", AM: "Administrator",
    OriginalPublisher: "Original publisher", SubPublisher: "Sub-publisher", RightsAdministrator: "Administrator",
    ComposerLyricist: "Composer / Lyricist", ComposerAuthor: "Composer / Author", Composer: "Composer", Author: "Author / Lyricist",
  };
  const writers = [], publishers = [], seen = new Set();
  const addPub = p => {
    if (!p) return;
    const key = (p.ipi || "") + "|" + (p.name || "");
    if (seen.has(key)) return;
    seen.add(key);
    publishers.push({ publisherName: p.name || "", publisherIpiNumber: p.ipi || "", publisherRole: ROLE[p.role] || p.role || "" });
  };
  for (const s of j.songwriters || []) {
    writers.push({ writerName: s.name || "", writerIPI: s.ipi || "", writerRoleCode: ROLE[s.role] || s.role || "" });
    for (const p of s.publishers || []) addPub(p);
  }
  for (const p of j.publishers || []) addPub(p);
  return {
    primaryTitle: j.song_title || j.recording_title || "", artists: j.artist_names || [],
    iswc: j.iswc || "", mlcSongCode: j.mlc_song_code || "", mlcUrl: j.mlc_portal_url || "", matchStatus: j.match_status || "",
    akas: [], writers, publishers,
  };
}

// ---- Deezer: open API, no key. Knows recordings (title, artist, album, ISRC), not writers. Errors come back as HTTP 200.
const DZ = "https://api.deezer.com";
async function dz(path) {
  const r = await fetch(`${DZ}${path}`, { headers: { Accept: "application/json", "User-Agent": MB_UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j && j.error ? null : j;
}
const dzRecording = t => ({
  id: t.id, title: t.title, isrc: (t.isrc || "").toUpperCase(),
  artist: (t.artist && t.artist.name) || "", album: (t.album && t.album.title) || "",
  releaseDate: t.release_date || "", link: t.link || "", labels: [],
});

// Auto mode. With an ISRC: credits.fm first, then Deezer to at least confirm the recording.
// With only artist and title: Deezer finds the recording and its ISRC, then credits.fm gets the writers.
async function lookupAuto(env, { isrc, artist, title }) {
  const trail = [], recordings = [], works = [], raw = {};
  let code = isrc || "";

  if (!code) {
    try {
      let s = await dz(`/search?q=${encodeURIComponent(`artist:"${clean(artist)}" track:"${clean(title)}"`)}&limit=3`);
      let hit = s && s.data && s.data[0];
      if (!hit) {
        // Looser second try: plain words, then keep the first result whose title and artist both look right.
        const norm = x => String(x || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
        s = await dz(`/search?q=${encodeURIComponent(`${clean(artist)} ${clean(title)}`)}&limit=10`);
        hit = ((s && s.data) || []).find(t => norm(t.title).includes(norm(title)) && norm(t.artist && t.artist.name).includes(norm(artist)));
        if (hit) trail.push("Deezer: strict search found nothing; a looser search found a match");
      }
      if (!hit) trail.push("Deezer: no recording found for that artist and title (strict and loose searches)");
      else {
        const full = await dz(`/track/${hit.id}`);
        if (full) {
          recordings.push(dzRecording(full));
          code = (full.isrc || "").toUpperCase();
          trail.push(`Deezer: found "${full.title}" by ${(full.artist && full.artist.name) || "unknown"}` + (code ? `, ISRC ${code}` : ", but it lists no ISRC"));
        }
      }
    } catch (e) { trail.push(`Deezer: ${e.message || e}`); }
  }

  if (code) {
    try {
      const c = await creditsByIsrc(env, code);
      if (c.found) {
        raw.credits_fm = c.data;   // untouched payload, so the Raw response panel shows exactly what credits.fm sent
        const w = creditsToWork(c.data);
        works.push(w);
        trail.push(`credits.fm: found (${w.writers.length} writers, ${w.publishers.length} publishers, MLC match: ${w.matchStatus || "unknown"})`);
      } else trail.push(`credits.fm: ${c.note}`);
    } catch (e) { trail.push(`credits.fm: ${e.message || e}`); }

    if (!works.length && !recordings.length) {
      try {
        const t = await dz(`/track/isrc:${encodeURIComponent(code)}`);
        if (t) {
          recordings.push(dzRecording(t));
          trail.push(`Deezer: found "${t.title}" by ${(t.artist && t.artist.name) || "unknown"} (recording only, no writer data)`);
        } else trail.push("Deezer: ISRC not found");
      } catch (e) { trail.push(`Deezer: ${e.message || e}`); }
    }
  }

  return {
    demo: false, source: "auto", trail, recordings, works, raw,
    attribution: works.length ? { text: "Songwriter and publisher data: credits.fm (CC-BY 4.0), sourced from The MLC.", url: `https://isrc.fm/${code}` } : null,
  };
}

export async function lookup(env, { isrc, artist, title, source }) {
  source = source || "auto";
  if (source === "auto") return lookupAuto(env, { isrc, artist, title });
  if (source === "musicbrainz") return lookupMB({ isrc, artist, title });  // always live, no login needed
  if (env.DEMO === "1") return DEMO_DATA;                                   // MLC stays in demo mode until DEMO = "0"
  const q = {};
  if (isrc) q.isrc = isrc.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (artist) q.artist = artist.trim();
  if (title) q.title = title.trim();
  const recordings = await mlc(env, "/search/recordings", q);
  const list = Array.isArray(recordings) ? recordings : [];
  // Spec spells the song code two ways; accept both.
  const codes = [...new Set(list.map(r => r.mlcsongCode || r.mlcSongCode).filter(Boolean))].slice(0, 5);
  let works = [];
  if (codes.length) {
    const w = await mlc(env, "/works", codes.map(c => ({ mlcsongCode: c })));
    works = Array.isArray(w) ? w : [];
  }
  return { demo: false, recordings: list, works };
}


// Shared by the test page (/lookup) and the artist upload form (/api/lookup).
// Returns { status, body } so each caller can wrap it in its own Response.
export async function validateAndLookup(env, body) {
  try {
    if (!body || typeof body !== "object") return { status: 400, body: { error: "Bad request." } };
    if (!body.isrc && !(body.title && body.artist)) {
      return { status: 400, body: { error: "Enter an ISRC, or both artist and title." } };
    }
    if (body.isrc) {
      const code = String(body.isrc).trim().toUpperCase().replace(/[\s-]/g, "");
      if (/^T\d{10}$/.test(code) || /^T[\d.]{11,13}\d$/.test(String(body.isrc).trim().toUpperCase().replace(/-/g, ""))) {
        return { status: 400, body: { error: "That looks like an ISWC (a code for the song itself), not an ISRC (a code for one recording, 12 characters like USRC17607839). Enter the ISRC, or use artist and title." } };
      }
      if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(code)) {
        return { status: 400, body: { error: "That doesn't look like an ISRC. An ISRC is 12 characters: 2 letters, then 3 letters or digits, then 7 digits (for example USRC17607839)." } };
      }
      body = { ...body, isrc: code };
    }
    return { status: 200, body: await lookup(env, body) };
  } catch (e) {
    return { status: 502, body: { error: String(e.message || e) } };
  }
}
