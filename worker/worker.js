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

async function lookup(env, { isrc, artist, title, source }) {
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (req.method === "POST" && url.pathname === "/lookup") {
      try {
        const body = await req.json();
        if (!body.isrc && !(body.title && body.artist)) {
          return Response.json({ error: "Enter an ISRC, or both artist and title." }, { status: 400 });
        }
        if (body.isrc) {
          const code = String(body.isrc).trim().toUpperCase().replace(/[\s-]/g, "");
          if (/^T\d{10}$/.test(code) || /^T[\d.]{11,13}\d$/.test(String(body.isrc).trim().toUpperCase().replace(/-/g, ""))) {
            return Response.json({ error: "That looks like an ISWC (a code for the song itself), not an ISRC (a code for one recording, 12 characters like USRC17607839). Enter the ISRC, or use artist and title." }, { status: 400 });
          }
          if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(code)) {
            return Response.json({ error: "That doesn't look like an ISRC. An ISRC is 12 characters: 2 letters, then 3 letters or digits, then 7 digits (for example USRC17607839)." }, { status: 400 });
          }
          body.isrc = code;
        }
        return Response.json(await lookup(env, body));
      } catch (e) {
        return Response.json({ error: String(e.message || e) }, { status: 502 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
};

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MLC Lookup Test</title>
<style>
:root{--bg:#222527;--card:#2b2e31;--text:#e8e6e1;--bronze:#b8935a;--mute:#9a978f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif;padding:24px}
main{max-width:760px;margin:0 auto}h1{font-weight:600;color:var(--bronze)}
form,.card{background:var(--card);border:1px solid #3a3d40;border-radius:8px;padding:18px;margin:16px 0}
label{display:block;margin:10px 0 4px;color:var(--mute);font-size:14px}
input{width:100%;padding:10px;border-radius:6px;border:1px solid #444;background:#1c1e20;color:var(--text);font-size:16px}
button{margin-top:14px;padding:10px 20px;border:0;border-radius:6px;background:var(--bronze);color:#1c1e20;font-weight:600;font-size:16px;cursor:pointer}
table{width:100%;border-collapse:collapse;margin-top:8px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #3a3d40;font-size:14px}th{color:var(--mute);font-weight:500}
.err{color:#e07a6a}.note{color:var(--mute);font-size:14px}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--mute)}
.tag{display:inline-block;padding:1px 8px;border-radius:10px;background:#3a3d40;font-size:12px;color:var(--bronze)}
</style></head><body><main>
<h1>MLC Lookup Test</h1>
<p class="note">Search by ISRC, or by artist and title. Results come straight from The MLC's public database.</p>
<form id="f">
<label>Source</label><select id="source" style="width:100%;padding:10px;border-radius:6px;border:1px solid #444;background:#1c1e20;color:var(--text);font-size:16px"><option value="musicbrainz">MusicBrainz (no login)</option><option value="mlc">The MLC (needs login)</option></select>
<label>ISRC</label><input id="isrc" placeholder="e.g. USRC17607839" autocomplete="off">
<label>Artist (optional with ISRC)</label><input id="artist" autocomplete="off">
<label>Title (optional with ISRC)</label><input id="title" autocomplete="off">
<button type="submit">Look up</button>
</form>
<div id="out"></div>
<script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
document.getElementById("f").addEventListener("submit",async e=>{
  e.preventDefault();const out=document.getElementById("out");out.innerHTML='<p class="note">Looking up\\u2026</p>';
  const body={isrc:isrc.value,artist:artist.value,title:title.value,source:source.value};
  let d;try{const r=await fetch("/lookup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});d=await r.json();
    if(!r.ok){out.innerHTML='<div class="card err">'+esc(d.error||"Lookup failed")+'</div>';return;}
  }catch(x){out.innerHTML='<div class="card err">'+esc(x.message)+'</div>';return;}
  let h=d.demo?'<p><span class="tag">DEMO DATA</span> <span class="note">Not real. Shows the layout only.</span></p>':'';
  if(d.warnings&&d.warnings.length)h+='<div class="card err">Partial result. MusicBrainz was busy: '+d.warnings.map(esc).join('; ')+'. Try again in a minute.</div>';
  if(!d.works.length){h+='<div class="card">No match in The MLC database'+(d.recordings.length?' (recording found, but no work record came back).':'.')+' The song may be unreleased or unregistered.</div>';}
  d.works.forEach(w=>{
    h+='<div class="card"><h2 style="margin:0 0 4px">'+esc(w.primaryTitle)+'</h2>'
     +'<div class="note">ISWC '+esc(w.iswc||"\\u2014")+' \\u00b7 MLC song code '+esc(w.mlcSongCode||"\\u2014")+(w.artists&&w.artists.length?' \\u00b7 '+esc(w.artists.join(", ")):'')+'</div>';
    if(w.akas&&w.akas.length)h+='<p class="note">Also known as: '+w.akas.map(a=>esc(a.akaTitle)).join("; ")+'</p>';
    h+='<h3>Writers</h3><table><tr><th>Name</th><th>IPI</th><th>Role</th></tr>'+(w.writers||[]).map(x=>'<tr><td>'+esc(x.writerName||((x.writerFirstName||"")+" "+(x.writerLastName||"")))+'</td><td>'+esc(x.writerIPI||"\\u2014")+'</td><td>'+esc(x.writerRoleCode||"\\u2014")+'</td></tr>').join("")+'</table>';
    h+='<h3>Publishers</h3><table><tr><th>Name</th><th>IPI</th><th>MLC #</th><th>Share</th><th>Administrator</th></tr>'+(w.publishers||[]).map(p=>'<tr><td>'+esc(p.publisherName)+'</td><td>'+esc(p.publisherIpiNumber||"\\u2014")+'</td><td>'+esc(p.mlcPublisherNumber||"\\u2014")+'</td><td>'+esc(p.collectionShare??"\\u2014")+'</td><td>'+esc((p.administrators||[]).map(a=>a.publisherName).join(", ")||"\\u2014")+'</td></tr>').join("")+'</table></div>';
  });
  h+='<details class="card"><summary>Raw response</summary><pre>'+esc(JSON.stringify(d,null,2))+'</pre></details>';
  out.innerHTML=h;
});
</script></main></body></html>`;
