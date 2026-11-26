// Test-page markup for GET / (the original MLC/credits lookup test page).
export const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
<h1>Song Lookup Test</h1>
<p class="note">Search by ISRC, or by artist and title. Auto asks credits.fm for the writers and publishers (their data comes from The MLC) and uses Deezer to find or confirm the recording. You can also pick MusicBrainz or The MLC directly.</p>
<form id="f">
<label>Source</label><select id="source" style="width:100%;padding:10px;border-radius:6px;border:1px solid #444;background:#1c1e20;color:var(--text);font-size:16px"><option value="auto">Auto: credits.fm, then Deezer</option><option value="musicbrainz">MusicBrainz (no login)</option><option value="mlc">The MLC (needs login)</option></select>
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
  const src=d.demo?"the demo data":(d.source==="musicbrainz"?"MusicBrainz":"The MLC database");
  if(d.trail&&d.trail.length)h+='<div class="card"><div class="note">What each source said</div><ul style="margin:6px 0 0;padding-left:20px">'+d.trail.map(t=>'<li>'+esc(t)+'</li>').join('')+'</ul></div>';
  if(d.source==="auto")(d.recordings||[]).forEach(r=>{h+='<div class="card"><div class="note">Recording</div><h3 style="margin:4px 0">'+esc(r.title)+'</h3><div class="note">'+esc(r.artist)+(r.album?' \\u00b7 '+esc(r.album):'')+(r.releaseDate?' \\u00b7 '+esc(r.releaseDate):'')+' \\u00b7 ISRC '+esc(r.isrc||"\\u2014")+'</div></div>';});
  if(!d.works.length){h+='<div class="card">'+(d.source==="auto"?(d.recordings.length?'Recording found, but no songwriter or publisher data came back from credits.fm.':'Nothing found. The song may be unreleased, or none of these sources know it yet.'):'No match in '+src+(d.recordings.length?' (recording found, but no work record came back).':'.')+' The song may be unreleased or unregistered.')+'</div>';}
  d.works.forEach(w=>{
    h+='<div class="card"><h2 style="margin:0 0 4px">'+esc(w.primaryTitle)+'</h2>'
     +'<div class="note">ISWC '+esc(w.iswc||"\\u2014")+' \\u00b7 MLC song code '+esc(w.mlcSongCode||"\\u2014")+(w.matchStatus?' \\u00b7 MLC match: '+esc(w.matchStatus):'')+(w.artists&&w.artists.length?' \\u00b7 '+esc(w.artists.join(", ")):'')+'</div>';
    if(w.mlcUrl&&/^https:\\/\\/portal\\.themlc\\.com\\//.test(w.mlcUrl))h+='<p class="note"><a href="'+esc(w.mlcUrl)+'" target="_blank" rel="noopener" style="color:var(--bronze)">Open this song in the MLC Portal</a></p>';
    if(w.akas&&w.akas.length)h+='<p class="note">Also known as: '+w.akas.map(a=>esc(a.akaTitle)).join("; ")+'</p>';
    h+='<h3>Writers</h3><table><tr><th>Name</th><th>IPI</th><th>Role</th></tr>'+(w.writers||[]).map(x=>'<tr><td>'+esc(x.writerName||((x.writerFirstName||"")+" "+(x.writerLastName||"")))+'</td><td>'+esc(x.writerIPI||"\\u2014")+'</td><td>'+esc(x.writerRoleCode||"\\u2014")+'</td></tr>').join("")+'</table>';
    h+='<h3>Publishers</h3><table><tr><th>Name</th><th>IPI</th><th>Role</th><th>MLC #</th><th>Share</th><th>Administrator</th></tr>'+(w.publishers||[]).map(p=>'<tr><td>'+esc(p.publisherName)+'</td><td>'+esc(p.publisherIpiNumber||"\\u2014")+'</td><td>'+esc(p.publisherRole||"\\u2014")+'</td><td>'+esc(p.mlcPublisherNumber||"\\u2014")+'</td><td>'+esc(p.collectionShare??"\\u2014")+'</td><td>'+esc((p.administrators||[]).map(a=>a.publisherName).join(", ")||"\\u2014")+'</td></tr>').join("")+'</table></div>';
  });
  if(d.attribution)h+='<p class="note">'+esc(d.attribution.text)+' <a href="'+esc(d.attribution.url)+'" style="color:var(--bronze)">'+esc(d.attribution.url)+'</a></p>';
  h+='<details class="card"><summary>Raw response</summary><pre>'+esc(JSON.stringify(d,null,2))+'</pre></details>';
  out.innerHTML=h;
});
</script></main></body></html>`;
