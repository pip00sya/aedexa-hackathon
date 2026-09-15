-- User projects.
--
-- Each record is stored as one JSON document: the server does not compute on it or
-- search inside it, it only returns it to its owner. The drawing never goes to the
-- server; it stays on the device.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'review',
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A user's project list is returned newest first.
CREATE INDEX IF NOT EXISTS projects_account ON projects (account_id, updated_at DESC);
