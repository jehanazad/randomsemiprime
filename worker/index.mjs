// Cloudflare Worker: serves index.html as a static asset and keeps an archive of rounds in D1.
//
//   GET /api/status            -> {first, last, count, firstTime, lastTime, tick: {started, finished, error}}
//   GET /api/n/<16 digits>     -> {n, rounds: [{round, n, randomness, signature}, ...]} newest first, or 404
//   GET /api/round/<round>     -> {round, n, randomness, signature} or 404
//   GET /api/range?from=&to=   -> {rounds: [...]} for a round range, newest first, at most RANGE_LIMIT
//
// A cron trigger runs archiveTick every minute: it records rounds newer than the archive's last
// round, then backfills older rounds. SUBREQUEST_BUDGET bounds the relay requests one run may make,
// every attempt including failovers (the free plan allows 50 external subrequests per invocation;
// D1 calls count separately). Each tick notes when it started and how it ended in the meta table.
// Rows only map N to a round; the page verifies each round's BLS signature in the browser.
import { sha256 } from '@noble/hashes/sha2.js';
import '../src/core.js';           // defines globalThis.SP (reads globalThis.__noble lazily)

globalThis.__noble = { sha256 };
const SP = globalThis.SP;
const CHAIN = SP.CHAIN;
const RANGE_LIMIT = 100;
const FETCH_TIMEOUT_MS = 5000;
const PARALLEL = 10;
const TICK_DEADLINE_MS = 40000;     // stop starting fetches after this, so runs do not pile up

const json = (body, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': cache, 'access-control-allow-origin': '*' } });

// ---- relay access ----
function relays(env) {
  return (env.DRAND_RELAYS ? String(env.DRAND_RELAYS).split(',') : CHAIN.relays).map(s => s.trim()).filter(Boolean);
}
// budget, when given, is {left: n}: each relay attempt takes one; none left means give up.
async function fetchRound(env, round, budget) {
  let lastErr;
  for (const relay of relays(env)) {
    if (budget) { if (budget.left <= 0) break; budget.left--; }
    try {
      const r = await fetch(relay + '/' + CHAIN.hash + '/public/' + round, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('request budget exhausted');
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
async function setMeta(db, k, v) {
  await db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?1, ?2)').bind(k, JSON.stringify(v)).run();
}
async function getMeta(db) {
  const { results } = await db.prepare('SELECT k, v FROM meta').all();
  const out = {};
  for (const r of results) { try { out[r.k.replace(/^tick_/, '')] = JSON.parse(r.v); } catch (e) { out[r.k] = r.v; } }
  return out;
}
async function insertRows(db, rows) {
  if (!rows.length) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO rounds (round, n, randomness, signature) VALUES (?1, ?2, ?3, ?4)');
  await db.batch(rows.map(r => stmt.bind(r.round, r.n, r.randomness, r.signature)));
}

// Fetch the given rounds (in order), PARALLEL at a time, within the budget and the deadline; stop at
// the first failure so the next run retries from there and the archive never develops holes.
// Returns the rows obtained.
async function collect(env, rounds, budget, deadline) {
  const out = [];
  for (let i = 0; i < rounds.length;) {
    if (Date.now() > deadline) { console.log('archive: deadline reached'); return out; }
    const chunk = rounds.slice(i, i + Math.min(PARALLEL, budget.left));
    if (!chunk.length) return out;
    i += chunk.length;
    const results = await Promise.all(chunk.map(r => fetchRound(env, r, budget).then(b => rowFromBeacon(b, r)).catch(e => ({ error: e, round: r }))));
    for (const r of results) {
      if (r.error) { console.log('archive: round ' + r.round + ' failed: ' + (r.error.message || r.error)); return out; }
      out.push(r);
    }
  }
  return out;
}

// One scheduled run. Exported for tests; `now` is unix seconds.
export async function archiveTick(env, now = Math.floor(Date.now() / 1000)) {
  const budget = { left: Math.max(1, Number(env.SUBREQUEST_BUDGET) || 45) };   // relay attempts this run
  const deadline = Date.now() + TICK_DEADLINE_MS;
  const current = SP.roundAt(now - 1);                 // one second of slack for relay lag
  if (current < 1) return { forward: 0, backward: 0 };
  await setMeta(env.DB, 'tick_started', { at: now, budget: budget.left });
  const { first, last } = await bounds(env.DB);
  // Forward: everything newer than the archive. An empty archive starts a little behind "now".
  const fwdStart = last ? last + 1 : Math.max(1, current - 19);
  const fwd = [];
  for (let r = fwdStart; r <= current && fwd.length < budget.left; r++) fwd.push(r);
  const fwdRows = await collect(env, fwd, budget, deadline);
  await insertRows(env.DB, fwdRows);
  // Backward: below the archive's first round, or below what was just inserted into an empty
  // archive. Nothing inserted into an empty archive means nothing to anchor to, so stop.
  const anchor = first ?? (fwdRows.length ? fwdRows[0].round : null);
  if (anchor === null) return { forward: fwdRows.length, backward: 0 };
  const bwd = [];
  for (let r = anchor - 1; r >= 1 && bwd.length < budget.left; r--) bwd.push(r);
  const bwdRows = await collect(env, bwd, budget, deadline);
  await insertRows(env.DB, bwdRows);
  return { forward: fwdRows.length, backward: bwdRows.length };
}
// The scheduled entry point: runs a tick and records how it ended.
async function runTick(env) {
  const started = Date.now();
  try {
    const r = await archiveTick(env);
    await setMeta(env.DB, 'tick_finished', { at: Math.floor(Date.now() / 1000), ms: Date.now() - started, ...r });
    console.log('archive: +' + r.forward + ' forward, +' + r.backward + ' backward');
  } catch (e) {
    console.log('archive tick failed: ' + (e.message || e));
    try { await setMeta(env.DB, 'tick_error', { at: Math.floor(Date.now() / 1000), message: String(e && e.message || e) }); } catch (e2) { /* nothing left to do */ }
  }
}

// ---- HTTP API ----
const ROW_COLS = 'round, n, randomness, signature';
async function api(url, env) {
  const p = url.pathname;
  let m;
  if (p === '/api/status') {
    const b = await bounds(env.DB);
    let tick = {};
    try { tick = await getMeta(env.DB); } catch (e) { tick = { error: 'meta table missing' }; }
    return json({ spec: 'beacon-semiprime v1', chain: CHAIN.hash, ...b,
      firstTime: b.first ? SP.roundTime(b.first) : null, lastTime: b.last ? SP.roundTime(b.last) : null, tick }, 200, 'public, max-age=30');
  }
  if ((m = /^\/api\/n\/(\d{16})$/.exec(p))) {
    // Distinct rounds can produce the same N (rare, but expected a few times per year of rounds).
    // The answer is cached briefly, not immutably: backfill can add an older round later.
    const { results } = await env.DB.prepare('SELECT ' + ROW_COLS + ' FROM rounds WHERE n = ?1 ORDER BY round DESC').bind(m[1]).all();
    return results.length ? json({ n: m[1], rounds: results }, 200, 'public, max-age=300') : json({ error: 'not in archive' }, 404);
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
    ctx.waitUntil(runTick(env));
  },
};
