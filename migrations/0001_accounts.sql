-- Accounts and sessions.
--
-- The password is stored as a PBKDF2 hash together with its parameters; the session
-- ID is stored as a hash too, so a stolen database row cannot be used to sign in.
--
-- Apply with:
--   npx wrangler d1 migrations apply aedexa --remote

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Looking up one account's sessions is needed to sign out of all devices.
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
-- Expired sessions are cleaned up by expiry date.
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
