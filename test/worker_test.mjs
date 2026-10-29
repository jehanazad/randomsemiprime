// Integration test for worker/index.mjs: runs `wrangler dev` locally against a mock drand relay,
// triggers the cron tick, and exercises the API. Usage: node test/worker_test.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { rowFromBeacon, archiveTick } from '../worker/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SP = globalThis.SP;
const CHAIN = SP.CHAIN;
const VEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-vectors.json'), 'utf8'));
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };

// ---- unit: rowFromBeacon on real vectors ----
const expectN = { 1: '8766449459018651', 20000000: '2842566290086427', 33470004: '3307786713929837' };
for (const v of VEC.rounds) check(rowFromBeacon(v, v.round).n === expectN[v.round], 'rowFromBeacon derives N for round ' + v.round);
try { rowFromBeacon({ ...VEC.rounds[0], signature: VEC.rounds[1].signature }, 1); check(false, 'tampered signature rejected'); }
catch (e) { check(/randomness/.test(e.message), 'tampered signature rejected: ' + e.message); }
try { rowFromBeacon(VEC.rounds[0], 2); check(false, 'wrong round rejected'); }
catch (e) { check(/round/.test(e.message), 'wrong round rejected'); }

// ---- mock relay: real vectors for their rounds, synthetic but self-consistent rounds otherwise ----
const failing = new Set();
let hits = 0;
function fakeRound(r) {
  const a = sha256(new TextEncoder().encode('sig-' + r)), b = sha256(new TextEncoder().encode('sig2-' + r));
  const sig = new Uint8Array(48); sig.set(a, 0); sig.set(b.slice(0, 16), 32);
  return { round: r, randomness: hex(sha256(sig)), signature: hex(sig) };
}
const real = Object.fromEntries(VEC.rounds.map(v => [v.round, v]));
const mock = http.createServer((req, res) => {
  hits++;
  const m = /\/public\/(\d+)$/.exec(req.url);
  const r = m && Number(m[1]);
  if (!r || failing.has(r)) { res.writeHead(500); res.end('nope'); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(real[r] || fakeRound(r)));
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const MOCK = 'http://127.0.0.1:' + mock.address().port;

// ---- unit: archiveTick against an in-memory store ----
{
  const rows = new Map();
  const mem = {
    prepare: sql => ({ bind: (...a) => ({ run: async () => { rows.set(a[0], { round: a[0], n: a[1], randomness: a[2], signature: a[3] }); } }),
      first: async () => { const ks = [...rows.keys()]; return { first: ks.length ? Math.min(...ks) : null, last: ks.length ? Math.max(...ks) : null, count: ks.length }; } }),
    batch: async stmts => { for (const s of stmts) await s.run(); },
  };
  const env = { DB: mem, DRAND_RELAYS: MOCK, SUBREQUEST_BUDGET: '30' };
  const now = 1793242214;
  const cur = SP.roundAt(now - 1);
  let r = await archiveTick(env, now);
  check(r.forward === 20 && r.backward === 10, `first tick fills 20 forward + 10 backward (${r.forward}+${r.backward})`);
  check(rows.has(cur) && rows.has(cur - 29) && rows.size === 30, 'archive covers current-29 .. current');
  r = await archiveTick(env, now + 6);       // two new rounds exist now
  check(r.forward === 2 && r.backward === 28, `second tick: 2 forward + 28 backward (${r.forward}+${r.backward})`);
  failing.add(cur - 57 - 5);                 // archive now spans cur-57..cur; the next backfill hits this at its 5th round
  r = await archiveTick(env, now + 6);
  check(r.forward === 0 && r.backward === 4, `backfill stops at the first failed round (${r.backward})`);
  failing.clear();
  r = await archiveTick(env, now + 6);
  check(r.backward === 30, 'and resumes from it next run');
  const ks = [...rows.keys()];
  check(Math.max(...ks) - Math.min(...ks) + 1 === rows.size, 'no holes in the archive');
}

// ---- integration: wrangler dev (local D1) ----
const PORT = 8790 + Math.floor(Math.random() * 100);
execSync('npx wrangler d1 execute randomsemiprime-archive --local --file schema.sql', { cwd: ROOT, stdio: 'ignore' });
execSync('npx wrangler d1 execute randomsemiprime-archive --local --command "DELETE FROM rounds"', { cwd: ROOT, stdio: 'ignore' });
const dev = spawn('npx', ['wrangler', 'dev', '--test-scheduled', '--ip', '127.0.0.1', '--port', String(PORT),
  '--var', 'DRAND_RELAYS:' + MOCK, '--var', 'SUBREQUEST_BUDGET:30'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let devLog = '';
dev.stdout.on('data', d => { devLog += d; }); dev.stderr.on('data', d => { devLog += d; });
const base = 'http://127.0.0.1:' + PORT;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { await new Promise(r => setTimeout(r, 500)); try { up = (await fetch(base + '/api/status')).ok; } catch (e) { /* not yet */ } }
  if (!up) throw new Error('wrangler dev did not start:\n' + devLog.slice(-2000));
  await fetch(base + '/api/status');
  const s0 = (await get('/api/status')).body;
  check(s0.count === 0 && s0.first === null, 'fresh archive is empty');
  const t0 = await fetch(base + '/__scheduled?cron=*+*+*+*+*');
  check(t0.ok, 'scheduled trigger accepted');
  let s1;
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 500)); s1 = (await get('/api/status')).body; if (s1.count >= 30) break; }
  const cur = SP.roundAt(Math.floor(Date.now() / 1000));
  check(s1.count === 30 && s1.last - s1.first === 29 && cur - s1.last <= 2, `tick archived 30 contiguous rounds up to now (count ${s1.count}, last ${s1.last}, current ${cur})`);
  check(s1.lastTime === SP.roundTime(s1.last), 'status reports round times');
  const range = (await get('/api/range?from=' + s1.first + '&to=' + s1.last)).body;
  check(range.rounds.length === 30 && range.rounds[0].round === s1.last && range.rounds[29].round === s1.first, 'range returns all rows newest first');
  const row = range.rounds[7];
  check(/^\d{16}$/.test(row.n) && row.n === SP.deriveN(row.randomness).toString(), 'rows carry N derived from randomness');
  const byN = await get('/api/n/' + row.n);
  check(byN.status === 200 && byN.body.round === row.round && /immutable/.test(byN.headers.get('cache-control')), 'lookup by N finds the round, cached immutably');
  const byR = await get('/api/round/' + row.round);
  check(byR.status === 200 && byR.body.n === row.n, 'lookup by round works');
  check((await get('/api/n/1234567890123456')).status === 404, 'unknown N is 404');
  check((await get('/api/n/123')).status === 404, 'short N is 404');
  check((await get('/api/range?from=5&to=4')).status === 400, 'reversed range is 400');
  check((await get('/api/range?from=1&to=101')).status === 400, '101-round range is 400');
  check((await get('/api/range?from=1&to=100')).body.rounds.length === 0, 'empty range is an empty list');
  check((await get('/api/nope')).status === 404, 'unknown api path is 404');
  check((await fetch(base + '/api/status', { method: 'POST' })).status === 405, 'POST is 405');
  const page = await fetch(base + '/');
  check(page.ok && /Beacon Semiprime/.test(await page.text()), 'index.html is served at /');
  check((await fetch(base + '/worker/index.mjs')).status === 404, 'worker source is not served as an asset');
  check((await fetch(base + '/schema.sql')).status === 404, 'schema.sql is not served as an asset');
} catch (e) { check(false, 'integration: ' + (e.message || e)); }
finally { dev.kill('SIGTERM'); mock.close(); }
console.log('\n%d failures', fails);
process.exit(fails ? 1 : 0);
