-- Media Pig AF song uploads. Cloudflare D1 (SQLite).
-- Types are loose in SQLite: dates are ISO-8601 text (UTC), ids are random text, not autoincrement,
-- because they appear in URLs. Keep each statement ending with a semicolon at the end of a line.

CREATE TABLE IF NOT EXISTS invites (
  id           TEXT PRIMARY KEY,
  artist_name  TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,          -- SHA-256 of the token, never the token itself
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  max_uses     INTEGER NOT NULL DEFAULT 20,   -- songs one link may start
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS songs (
  id            TEXT PRIMARY KEY,
  invite_id     TEXT NOT NULL REFERENCES invites(id),
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL,
  isrc          TEXT,
  iswc          TEXT,
  mlc_song_code TEXT,
  pro           TEXT,                          -- primary PRO for the song
  pro_work_code TEXT,                          -- the PRO's own work or registration number
  self_published INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft, submitted, in_review, needs_info, accepted
  admin_notes   TEXT,
  created_at    TEXT NOT NULL,
  submitted_at  TEXT,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS songs_invite ON songs(invite_id);
CREATE INDEX IF NOT EXISTS songs_status ON songs(status);

CREATE TABLE IF NOT EXISTS writers (
  id        TEXT PRIMARY KEY,
  song_id   TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  name      TEXT NOT NULL,
  ipi       TEXT,
  pro       TEXT,
  role      TEXT,
  share_pct REAL
);
CREATE INDEX IF NOT EXISTS writers_song ON writers(song_id);

CREATE TABLE IF NOT EXISTS publishers (
  id        TEXT PRIMARY KEY,
  song_id   TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  name      TEXT NOT NULL,
  ipi       TEXT,
  pro       TEXT,
  share_pct REAL
);
CREATE INDEX IF NOT EXISTS publishers_song ON publishers(song_id);

CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  song_id     TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                  -- proof, master_print, master_instrumental
  orig_name   TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  declared_bytes INTEGER NOT NULL,
  bytes       INTEGER,                        -- set once the upload is verified
  detected    TEXT,                           -- type found from the file's own first bytes
  upload_id   TEXT,
  parts_json  TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'uploading', -- uploading, ready, rejected, replaced
  etag        TEXT,
  created_at  TEXT NOT NULL,
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS files_song ON files(song_id);

CREATE TABLE IF NOT EXISTS lookups (
  id         TEXT PRIMARY KEY,
  invite_id  TEXT NOT NULL REFERENCES invites(id),
  song_id    TEXT REFERENCES songs(id) ON DELETE CASCADE,  -- filled in when the artist saves a song
  query      TEXT,
  result_json TEXT,                           -- recorded by the server at lookup time, to compare with what the artist submitted
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lookups_invite ON lookups(invite_id);

CREATE TABLE IF NOT EXISTS status_log (
  id      TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  status  TEXT NOT NULL,
  note    TEXT,
  by_who  TEXT,
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS status_log_song ON status_log(song_id);
