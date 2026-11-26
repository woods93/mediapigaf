// Media Pig AF Worker. One deployment, several jobs:
//   GET  /            the original lookup test page          POST /lookup  (test page's lookup)
//   GET  /upload      artist upload form (invite link)       /api/*        its API (invite token required)
//   GET  /admin       admin page (Cloudflare Access)         /admin/*      its API and file downloads
// Bindings: DB (D1), BUCKET (R2). Secrets and vars are listed in README.md.

import { handleAdmin } from "./src/admin.js";
import { ensureSchema } from "./src/db.js";
import { validateAndLookup } from "./src/lookup.js";
import { PAGE } from "./src/testpage.js";
import { handleUpload } from "./src/upload.js";
import { HttpError, SEC_HEADERS, json, readJson } from "./src/util.js";

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (req.method === "GET" && p === "/") {
        return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (req.method === "GET" && p === "/robots.txt") {
        return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain", ...SEC_HEADERS } });
      }
      if (req.method === "POST" && p === "/lookup") {
        const out = await validateAndLookup(env, await readJson(req, 5_000));
        return Response.json(out.body, { status: out.status });
      }
      if (p === "/admin" || p.startsWith("/admin/")) {
        await ensureSchema(env);
        return await handleAdmin(req, env, url);
      }
      if (p === "/upload" || p.startsWith("/api/")) {
        if (p !== "/upload") await ensureSchema(env);
        const r = await handleUpload(req, env, url);
        if (r) return r;
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      if (e instanceof HttpError) {
        // Browsers asking for a page get a readable message; the API callers get JSON.
        const wantsHtml = req.method === "GET" && !p.startsWith("/api/") && !p.startsWith("/admin/api/") && !p.startsWith("/admin/files/");
        if (wantsHtml) return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;background:#222527;color:#e8e6e1;padding:32px"><p>${e.message.replace(/[<>&]/g, "")}</p>`, { status: e.status, headers: { "Content-Type": "text/html; charset=utf-8", ...SEC_HEADERS } });
        return json({ error: e.message }, e.status);
      }
      console.error(e && e.stack || e);
      return json({ error: "Something went wrong on our side. Please try again." }, 500);
    }
  },
};
