# Media Pig AF Worker

One Cloudflare Worker (`mlc-lookup-test`) with several jobs:

| Path | What | Who |
|---|---|---|
| `/` and `POST /lookup` | Original lookup test page | public (test only) |
| `/upload?t=TOKEN` | Artist song-upload form | anyone holding an invite link |
| `/api/*` | The form's API (lookup, song, chunked file upload) | invite token required on every call |
| `/admin` and `/admin/*` | Invites, submissions, file downloads | Cloudflare Access only |

## Bindings, variables, secrets

| Name | Kind | Purpose |
|---|---|---|
| `DB` | D1 database `mediapigaf-uploads` | Song metadata. The Worker applies `migrations/*.sql` itself on first request. |
| `BUCKET` | R2 bucket `mediapigaf-uploads` | Uploaded files, under `artists/<artist>/<song>/<kind>/` |
| `ACCESS_TEAM_DOMAIN` | var | e.g. `yourteam.cloudflareaccess.com`. Admin stays locked until this and `ACCESS_AUD` are set. |
| `ACCESS_AUD` | var | The Access application's Audience (AUD) tag |
| `TURNSTILE_SITEKEY`, `TURNSTILE_SECRET` | var, secret | Optional. When both are set the form shows the human check and the server enforces it. |
| `CREDITS_KEY` | secret | Optional free credits.fm key (higher rate limit) |
| `MLC_USER`, `MLC_PASS`, `DEMO` | secrets, var | MLC lookup, still in demo mode |
| `ADMIN_DEV_BYPASS` | local only | `.dev.vars` file, honoured only on localhost. Never set in production. |

## Rules enforced on the server (the browser repeats them only for convenience)

- Files: 100 MB each, three slots (proof, master print, master instrumental), type checked from the file's own first bytes, extension must match the contents.
- Upload is chunked (8 MiB) through the Worker; each chunk's size is checked, the total is checked at the end.
- Fields: ISRC format, ISWC format and check digit, IPI 9 to 11 digits, shares 0 to 100, PRO and role from fixed lists.
- Invites: stored as a SHA-256 hash, expire (default 14 days), allow N songs (default 20), revocable.

## Local development

```
npx wrangler dev --local
```

Put `ADMIN_DEV_BYPASS=1` in `worker/.dev.vars` to use `/admin` on localhost.

## Housekeeping to do before go-live

- R2: add a lifecycle rule to abort incomplete multipart uploads after a day or two.
- Put the Worker on a custom domain (for example `upload.mediapigaf.com`), then protect `/admin*` with Access on that hostname and turn off the workers.dev route.
- Revisit the 100 MB cap, and decide what to do with `/` (the public test page).
