// Server-side validation. The browser repeats some of these checks for convenience, but only these count.

export const MAX_FILE_BYTES = 100 * 1024 * 1024;   // POC cap
export const CHUNK_BYTES = 8 * 1024 * 1024;         // R2 multipart: every part the same size except the last, 5 MiB minimum

export const PROS = ["ASCAP", "BMI", "SESAC", "GMR", "SOCAN", "PRS", "OTHER", "NONE"];
export const WRITER_ROLES = ["Composer/Lyricist", "Composer", "Lyricist", "Arranger", "Other"];
export const STATUSES = ["draft", "submitted", "in_review", "needs_info", "accepted"];

// ---- Files ---------------------------------------------------------------------------------------------

export const FILE_KINDS = {
  proof:               { label: "Proof of publishing", types: ["pdf", "png", "jpeg"], exts: { pdf: ["pdf"], png: ["png"], jpeg: ["jpg", "jpeg"] } },
  master_print:        { label: "Master print",        types: ["wav", "mp3", "flac", "aiff"], exts: { wav: ["wav"], mp3: ["mp3"], flac: ["flac"], aiff: ["aif", "aiff"] } },
  master_instrumental: { label: "Master instrumental", types: ["wav", "mp3", "flac", "aiff"], exts: { wav: ["wav"], mp3: ["mp3"], flac: ["flac"], aiff: ["aif", "aiff"] } },
};

const ascii = (b, from, s) => s.split("").every((ch, i) => b[from + i] === ch.charCodeAt(0));

// Identifies a file from its own first bytes (needs at least 12). Returns null when it matches nothing we accept.
export function detectType(b) {
  if (!b || b.length < 4) return null;
  if (ascii(b, 0, "%PDF-")) return "pdf";
  if (b[0] === 0x89 && ascii(b, 1, "PNG") && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return "wav";
  if (b.length >= 12 && ascii(b, 0, "FORM") && (ascii(b, 8, "AIFF") || ascii(b, 8, "AIFC"))) return "aiff";
  if (ascii(b, 0, "fLaC")) return "flac";
  if (ascii(b, 0, "ID3")) return "mp3";
  // Bare MP3 frame: 11 sync bits, and a layer other than 00 (layer 00 is AAC/ADTS, which we don't take)
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ((b[1] >> 1) & 3) !== 0 && ((b[1] >> 3) & 3) !== 1) return "mp3";
  return null;
}

// Checks name, declared size, and (optionally) the first bytes. Returns { ok, error, detected }.
export function checkFile(kind, name, size, head) {
  const k = FILE_KINDS[kind];
  if (!k) return { ok: false, error: "Unknown file type for this slot." };
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "That file is empty." };
  if (size > MAX_FILE_BYTES) return { ok: false, error: `That file is ${(size / 1048576).toFixed(1)} MB. The limit is ${MAX_FILE_BYTES / 1048576} MB.` };
  const ext = (String(name).split(".").pop() || "").toLowerCase();
  const allowedExts = k.types.flatMap(t => k.exts[t]);
  if (!allowedExts.includes(ext)) return { ok: false, error: `${k.label} must be one of: ${allowedExts.join(", ")}.` };
  if (head) {
    const detected = detectType(head);
    if (!detected || !k.types.includes(detected)) return { ok: false, error: `That file's contents don't look like a real ${k.types.join("/")} file.` };
    if (!k.exts[detected].includes(ext)) return { ok: false, error: `That file is named .${ext} but its contents are ${detected}. Please check you chose the right file.` };
    return { ok: true, detected };
  }
  return { ok: true };
}

// ---- Fields --------------------------------------------------------------------------------------------

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const txt = (v, max) => String(v ?? "").replace(CTRL, "").trim().slice(0, max);

export function normIsrc(v) { return String(v || "").toUpperCase().replace(/[\s-]/g, ""); }
export const isIsrc = v => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(v);

// ISWC T-123.456.789-0, with check digit.
export function normIswc(v) {
  const c = String(v || "").toUpperCase().replace(/[\s.\-]/g, "");
  return /^T\d{10}$/.test(c) ? `T-${c.slice(1, 4)}.${c.slice(4, 7)}.${c.slice(7, 10)}-${c[10]}` : null;
}
export function iswcCheckOk(v) {
  const c = String(v).replace(/[^0-9]/g, "");
  if (c.length !== 10) return false;
  let sum = 1;
  for (let i = 0; i < 9; i++) sum += (i + 1) * Number(c[i]);
  return (10 - (sum % 10)) % 10 === Number(c[9]);
}

export const normIpi = v => String(v || "").replace(/[\s.\-]/g, "");
export const isIpi = v => /^\d{9,11}$/.test(v);

const pct = v => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export function validateSong(input) {
  const errors = [], err = (field, message) => errors.push({ field, message });
  const i = input && typeof input === "object" ? input : {};
  const c = {
    title: txt(i.title, 200), artist: txt(i.artist, 200),
    isrc: normIsrc(i.isrc), iswc: "", mlc_song_code: txt(i.mlc_song_code, 20).toUpperCase().replace(/[^A-Z0-9]/g, ""),
    pro: txt(i.pro, 12).toUpperCase(), pro_work_code: txt(i.pro_work_code, 60),
    self_published: i.self_published ? 1 : 0, notes: txt(i.notes, 5000), writers: [], publishers: [],
  };
  if (!c.title) err("title", "Song title is required.");
  if (!c.artist) err("artist", "Artist name is required.");
  if (c.isrc && !isIsrc(c.isrc)) err("isrc", "An ISRC is 12 characters: 2 letters, 3 letters or digits, then 7 digits.");
  if (i.iswc && String(i.iswc).trim()) {
    const n = normIswc(i.iswc);
    if (!n) err("iswc", "An ISWC looks like T-123.456.789-0.");
    else if (!iswcCheckOk(n)) err("iswc", "That ISWC's check digit doesn't match. Please re-check it.");
    else c.iswc = n;
  }
  if (c.pro && !PROS.includes(c.pro)) err("pro", "Choose a PRO from the list.");
  if (!c.pro) c.pro = "";

  const wr = Array.isArray(i.writers) ? i.writers.slice(0, 20) : [];
  wr.forEach((w, n) => {
    const row = { name: txt(w && w.name, 200), ipi: normIpi(w && w.ipi), pro: txt(w && w.pro, 12).toUpperCase(), role: txt(w && w.role, 40), share_pct: pct(w && w.share_pct) };
    const blank = !row.name && !row.ipi && !row.pro && !row.role && row.share_pct === null;
    if (blank) return;
    const f = `writers.${n}`;
    if (!row.name) err(`${f}.name`, "Each writer needs a name.");
    if (row.ipi && !isIpi(row.ipi)) err(`${f}.ipi`, "An IPI is 9 to 11 digits.");
    if (row.pro && !PROS.includes(row.pro)) err(`${f}.pro`, "Choose a PRO from the list.");
    if (row.role && !WRITER_ROLES.includes(row.role)) err(`${f}.role`, "Choose a role from the list.");
    if (row.share_pct !== null && (Number.isNaN(row.share_pct) || row.share_pct < 0 || row.share_pct > 100)) err(`${f}.share_pct`, "A share is a number from 0 to 100.");
    c.writers.push(row);
  });
  if (!c.writers.length) err("writers", "Add at least one songwriter.");

  const pb = Array.isArray(i.publishers) ? i.publishers.slice(0, 20) : [];
  pb.forEach((p, n) => {
    const row = { name: txt(p && p.name, 200), ipi: normIpi(p && p.ipi), pro: txt(p && p.pro, 12).toUpperCase(), share_pct: pct(p && p.share_pct) };
    if (!row.name && !row.ipi && !row.pro && row.share_pct === null) return;
    const f = `publishers.${n}`;
    if (!row.name) err(`${f}.name`, "Each publisher needs a name.");
    if (row.ipi && !isIpi(row.ipi)) err(`${f}.ipi`, "An IPI is 9 to 11 digits.");
    if (row.pro && !PROS.includes(row.pro)) err(`${f}.pro`, "Choose a PRO from the list.");
    if (row.share_pct !== null && (Number.isNaN(row.share_pct) || row.share_pct < 0 || row.share_pct > 100)) err(`${f}.share_pct`, "A share is a number from 0 to 100.");
    c.publishers.push(row);
  });
  return { errors, clean: c };
}

// ---- Requirements and action items, derived from what is stored (never stored themselves) ---------------

const sum = rows => rows.reduce((a, r) => a + (Number(r.share_pct) || 0), 0);
const near100 = n => Math.abs(n - 100) < 0.01;

export function actionItems(song, writers, publishers, files) {
  const items = [], add = (level, code, text) => items.push({ level, code, text });
  const ready = k => files.some(f => f.kind === k && f.status === "ready");

  if (!ready("proof")) add("needed", "proof", "Proof of publishing or registration (a PDF or screenshot from your PRO or publisher) is missing.");
  if (!ready("master_print")) add("needed", "master_print", "The master print (WAV, MP3, FLAC or AIFF) is missing.");
  if (!ready("master_instrumental")) add("recommended", "master_instrumental", "No master instrumental was uploaded.");

  if (!song.isrc) add("recommended", "isrc", "No ISRC yet. It is needed once the recording is released or distributed.");
  if (!song.pro || song.pro === "NONE") add("recommended", "pro", "No PRO affiliation given for this song.");
  else if (!song.pro_work_code) add("recommended", "pro_work_code", `No ${song.pro} work code or registration number given.`);

  const wShares = writers.filter(w => w.share_pct != null);
  if (!wShares.length) add("recommended", "writer_shares", "Writer splits (percent shares) were not entered.");
  else if (!near100(sum(writers))) add("needed", "writer_shares", `Writer shares add up to ${+sum(writers).toFixed(2)}%, not 100%.`);
  for (const w of writers) if (!w.ipi) add("recommended", "writer_ipi", `${w.name} has no IPI number.`);

  if (!publishers.length && !song.self_published) add("recommended", "publishers", "No publisher listed. Add one, or tick self-published.");
  const pShares = publishers.filter(p => p.share_pct != null);
  if (publishers.length && pShares.length && !near100(sum(publishers))) add("needed", "publisher_shares", `Publisher shares add up to ${+sum(publishers).toFixed(2)}%, not 100%.`);

  if (!song.iswc) add("info", "iswc", "No ISWC. The PRO normally assigns it after the song is registered.");
  return items;
}
