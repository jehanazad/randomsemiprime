// Cloudflare Worker: serves index.html as a static asset and keeps an archive of rounds in D1.
//
//   GET /api/status            -> {first, last, count, firstTime, lastTime}
//   GET /api/n/<16 digits>     -> {round, n, randomness, signature} or 404
//   GET /api/round/<round>     -> same, by round number
//   GET /api/range?from=&to=   -> {rounds: [...]} for a round range, newest first, at most RANGE_LIMIT
//
// A cron trigger runs archiveTick every minute: it records rounds newer than the archive's last
// round, then backfills older rounds, within a per-run budget of relay requests (SUBREQUEST_BUDGET).
// Rows only map N to a round; the page verifies each round's BLS signature in the browser.
import { sha256 } from '@noble/hashes/sha2.js';
import '../src/core.js';           // defines globalThis.SP (reads globalThis.__noble lazily)

globalThis.__noble = { sha256 };
const SP = globalThis.SP;
const CHAIN = SP.CHAIN;
const RANGE_LIMIT = 100;
const FETCH_TIMEOUT_MS = 5000;
const PARALLEL = 10;

const json = (body, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': cache, 'access-control-allow-origin': '*' } });

// ---- relay access ----
function relays(env) {
  return (env.DRAND_RELAYS ? String(env.DRAND_RELAYS).split(',') : CHAIN.relays).map(s => s.trim()).filter(Boolean);
}
async function fetchRound(env, round) {
  let lastErr;
  for (const relay of relays(env)) {
    try {
      const r = await fetch(relay + '/' + CHAIN.hash + '/public/' + round, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no relay');
}
// Turn a relay response into an archive row, or throw. Checks shape and randomness = SHA-256(signature).
export function rowFromBeacon(b, expectedRound) {
  const round = Number(b && b.round);
  if (round !== expectedRound) throw new Error('round mismatch');
  const randomness = String(b.randomness).toLowerCase(), signature = String(b.signature).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(randomness) || !/^[0-9a-f]{96}$/.test(signature)) throw new Error('malformed beacon');
  if (!SP.randomnessMatches(randomness, signature)) throw new Error('randomness != sha256(signature)');
  return { round, n: SP.deriveN(randomness).toString(), randomness, signature };
}

// ---- D1 ----
async function bounds(db) {
  const r = await db.prepare('SELECT MIN(round) AS first, MAX(round) AS last, COUNT(*) AS count FROM rounds').first();
  return { first: r.first ?? null, last: r.last ?? null, count: r.count ?? 0 };
}
async function insertRows(db, rows) {
  if (!rows.length) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO rounds (round, n, randomness, signature) VALUES (?1, ?2, ?3, ?4)');
  await db.batch(rows.map(r => stmt.bind(r.round, r.n, r.randomness, r.signature)));
}

// Fetch the given rounds (in order), PARALLEL at a time; stop at the first failure so the next run
// retries from there and the archive never develops holes. Returns the rows obtained.
async function collect(env, rounds) {
  const out = [];
  for (let i = 0; i < rounds.length; i += PARALLEL) {
    const chunk = rounds.slice(i, i + PARALLEL);
    const results = await Promise.all(chunk.map(r => fetchRound(env, r).then(b => rowFromBeacon(b, r)).catch(e => ({ error: e, round: r }))));
    for (const r of results) {
      if (r.error) { console.log('archive: round ' + r.round + ' failed: ' + (r.error.message || r.error)); return out; }
      out.push(r);
    }
  }
  return out;
}

// One scheduled run. Exported for tests; `now` is unix seconds.
export async function archiveTick(env, now = Math.floor(Date.now() / 1000)) {
  const budget = Math.max(1, Number(env.SUBREQUEST_BUDGET) || 45);
  const current = SP.roundAt(now - 1);                 // one second of slack for relay lag
  if (current < 1) return { forward: 0, backward: 0 };
  const { first, last } = await bounds(env.DB);
  // Forward: everything newer than the archive. An empty archive starts a little behind "now".
  const fwdStart = last ? last + 1 : Math.max(1, current - 19);
  const fwd = [];
  for (let r = fwdStart; r <= current && fwd.length < budget; r++) fwd.push(r);
  const fwdRows = await collect(env, fwd);
  await insertRows(env.DB, fwdRows);
  // Backward: older rounds, with whatever budget is left.
  const bwd = [];
  const bwdStart = (first ?? fwdStart) - 1;
  for (let r = bwdStart; r >= 1 && bwd.length < budget - fwd.length; r--) bwd.push(r);
  const bwdRows = await collect(env, bwd);
  await insertRows(env.DB, bwdRows);
  return { forward: fwdRows.length, backward: bwdRows.length };
}

// ---- HTTP API ----
const ROW_COLS = 'round, n, randomness, signature';
async function api(url, env) {
  const p = url.pathname;
  let m;
  if (p === '/api/status') {
    const b = await bounds(env.DB);
    return json({ spec: 'beacon-semiprime v1', chain: CHAIN.hash, ...b,
      firstTime: b.first ? SP.roundTime(b.first) : null, lastTime: b.last ? SP.roundTime(b.last) : null }, 200, 'public, max-age=30');
  }
  if ((m = /^\/api\/n\/(\d{16})$/.exec(p))) {
    const row = await env.DB.prepare('SELECT ' + ROW_COLS + ' FROM rounds WHERE n = ?1').bind(m[1]).first();
    return row ? json(row, 200, 'public, max-age=31536000, immutable') : json({ error: 'not in archive' }, 404);
  }
  if ((m = /^\/api\/round\/(\d{1,12})$/.exec(p))) {
    const row = await env.DB.prepare('SELECT ' + ROW_COLS + ' FROM rounds WHERE round = ?1').bind(Number(m[1])).first();
    return row ? json(row, 200, 'public, max-age=31536000, immutable') : json({ error: 'not in archive' }, 404);
  }
  if (p === '/api/range') {
    const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return json({ error: 'from and to must be round numbers with from <= to' }, 400);
    if (to - from + 1 > RANGE_LIMIT) return json({ error: 'at most ' + RANGE_LIMIT + ' rounds per request' }, 400);
    const { results } = await env.DB.prepare('SELECT ' + ROW_COLS + ' FROM rounds WHERE round BETWEEN ?1 AND ?2 ORDER BY round DESC').bind(from, to).all();
    return json({ from, to, rounds: results }, 200, 'public, max-age=30');
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
      try { return await api(url, env); }
      catch (e) { console.log('api error: ' + (e.message || e)); return json({ error: 'archive error' }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(archiveTick(env).then(r => console.log('archive: +' + r.forward + ' forward, +' + r.backward + ' backward'))
      .catch(e => console.log('archive tick failed: ' + (e.message || e))));
  },
};
