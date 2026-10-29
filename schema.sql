-- Archive of quicknet rounds and the semiprime each one produced (SPEC.md v1).
-- Apply remotely:  npx wrangler d1 execute randomsemiprime-archive --remote --file schema.sql
-- Apply locally:   npx wrangler d1 execute randomsemiprime-archive --local --file schema.sql
CREATE TABLE IF NOT EXISTS rounds (
  round      INTEGER PRIMARY KEY,   -- quicknet round number
  n          TEXT    NOT NULL,      -- 16-digit N as text (exceeds 2^53, so never a JS number)
  randomness TEXT    NOT NULL,      -- 32 bytes hex
  signature  TEXT    NOT NULL       -- 48 bytes hex, verifiable against the chain public key
);
CREATE UNIQUE INDEX IF NOT EXISTS rounds_n ON rounds(n);
