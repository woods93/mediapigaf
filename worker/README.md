# Lookup test Worker

Cloudflare Worker that serves a small test form and looks up song metadata.

- Source "MusicBrainz": live, no login (free API, 1 request per second).
- Source "The MLC": demo data until `DEMO` is set to `"0"` in `wrangler.toml` and the
  secrets `MLC_USER` and `MLC_PASS` are added in Cloudflare (never commit them).

Deploy: Cloudflare, Workers & Pages, Create, Import a repository, pick this repo,
set the root directory to `worker`.
