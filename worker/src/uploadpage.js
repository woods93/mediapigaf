import page from "../pages/upload.html";

// Adds the Cloudflare Turnstile widget only when a site key is configured.
export function renderUploadPage({ sitekey }) {
  const sk = /^[A-Za-z0-9_-]{1,64}$/.test(sitekey || "") ? sitekey : "";
  const extra = sk
    ? `<meta name="ts-sitekey" content="${sk}"><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=tsReady" async defer></script>`
    : "";
  return page.replace("<!--TURNSTILE-->", extra);
}
