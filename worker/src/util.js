// Small shared helpers: ids, tokens, hashing, responses.

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function randomId(bytes = 16) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let out = "";
  for (const x of b) out += B32[x & 31];
  return out;
}

// 128-bit invite token, URL-safe.
export function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
}

export const nowIso = () => new Date().toISOString();

export function slug(s, max = 40) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "artist";
}

// Keeps letters, digits, dot, dash, underscore. Never trusts a client file name for a storage key.
export function safeName(s, max = 80) {
  const n = String(s || "file").replace(/[\\/]/g, "_").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, max);
  return n || "file";
}

export const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",   // invite tokens ride in the page URL
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...SEC_HEADERS, ...extra },
  });
}

export function html(body, status = 200, extraCsp = {}) {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(extraCsp.script || [])].join(" ");
  const frameSrc = (extraCsp.frame || []).join(" ") || "'none'";
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...SEC_HEADERS,
      "Content-Security-Policy": `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src ${frameSrc}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    },
  });
}

export async function readJson(req, maxBytes = 200_000) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > maxBytes) throw new HttpError(413, "That request is too large.");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "That request is too large.");
  try { return JSON.parse(text || "{}"); } catch { throw new HttpError(400, "Bad request."); }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Escapes text for HTML. Used server-side only where we build markup; pages use textContent.
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
