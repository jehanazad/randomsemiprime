-- Archive of quicknet rounds and the semiprime each one produced at every tier (SPEC.md v2).
-- Apply remotely:  npx wrangler d1 execute randomsemiprime-archive --remote --file schema.sql
-- Apply locally:   npx wrangler d1 execute randomsemiprime-archive --local --file schema.sql
CREATE TABLE IF NOT EXISTS rounds (
  round      INTEGER PRIMARY KEY,   -- quicknet round number
  n5         TEXT    NOT NULL,      -- N at each tier, as text (16 digits exceed 2^53, so never a JS number)
  n7         TEXT    NOT NULL,
  n10        TEXT    NOT NULL,
  n16        TEXT    NOT NULL,
  randomness TEXT    NOT NULL,      -- 32 bytes hex
  signature  TEXT    NOT NULL       -- 48 bytes hex, verifiable against the chain public key
);
-- Not unique: distinct rounds can share an N.
CREATE INDEX IF NOT EXISTS rounds_n5 ON rounds(n5);
CREATE INDEX IF NOT EXISTS rounds_n7 ON rounds(n7);
CREATE INDEX IF NOT EXISTS rounds_n10 ON rounds(n10);
CREATE INDEX IF NOT EXISTS rounds_n16 ON rounds(n16);
-- Tick bookkeeping, so /api/status can report the cron's health without log access:
-- k = 'tick_started' | 'tick_finished' | 'tick_error', v = JSON.
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
