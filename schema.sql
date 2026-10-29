-- Archive of quicknet rounds and the semiprime each one produced (SPEC.md v1).
-- Apply remotely:  npx wrangler d1 execute randomsemiprime-archive --remote --file schema.sql
-- Apply locally:   npx wrangler d1 execute randomsemiprime-archive --local --file schema.sql
CREATE TABLE IF NOT EXISTS rounds (
  round      INTEGER PRIMARY KEY,   -- quicknet round number
  n          TEXT    NOT NULL,      -- 16-digit N as text (exceeds 2^53, so never a JS number)
  randomness TEXT    NOT NULL,      -- 32 bytes hex
  signature  TEXT    NOT NULL       -- 48 bytes hex, verifiable against the chain public key
);
-- Not unique: distinct rounds can share an N. Dropped first so an older unique index is replaced.
DROP INDEX IF EXISTS rounds_n;
CREATE INDEX rounds_n ON rounds(n);
-- Tick bookkeeping, so /api/status can report the cron's health without log access:
-- k = 'tick_started' | 'tick_finished' | 'tick_error', v = JSON.
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
