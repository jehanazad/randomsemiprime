# Random Semiprime

A fresh 16-digit semiprime every 3 seconds, derived deterministically from the
[drand](https://drand.love) quicknet randomness beacon, for live tests of mental factoring.
Live at [randomsemiprime.com](https://randomsemiprime.com).

Because each number is a fixed function of a signed, timestamped beacon round that nobody
can predict, the number shown at any moment could not have been known in advance, and
anyone can later recompute it from the round and check the beacon's signature.

## Use

Open `index.html` — from the deployed site, any web server, or directly as a file. It needs
network access to a drand relay (`api.drand.sh`, `api2.drand.sh`, `api3.drand.sh`,
`drand.cloudflare.com`) for the live ticker. Verifying a number by its digits or words needs the
archive (`/api/*`, see below), which exists only on the deployed site; everything else runs in
the browser.

1. **Generate** shows the number from the round that was current when you arrived, as 16 digits and
   as 5 words. It stays put so it can be read calmly; new rounds keep arriving every 3 s in the
   **Recent rounds** list below it (newest first, last 200 kept). **Update** replaces the shown
   number with the newest round. Press **Capture** to freeze the shown number and start the clock.
2. Enter the answer: one or two factors, as 8-digit numbers or 3 words each. **Check** records
   the result and time in the session log. The page never shows the factors.
3. **Export JSON** (or **Copy JSON** where downloads are blocked) saves a transcript containing
   each round's signature, so a third party can verify everything offline.
4. **Verify** takes a round number, a 16-digit number (spaces between digit groups are
   fine), or its 5 words. A round number is
   fetched from drand; a number or words are looked up in the archive to find their round. Either
   way the round's BLS signature is checked in the browser, the number is re-derived, and the
   result says which 3-second window the number was showing in. A factor can then be checked
   against it, as digits or words.
5. **Numbers shown in a time range** lists every round between two times (local time or UTC),
   newest first, at most 100 rounds (5 minutes) per lookup: archive rows first, and anything the
   archive lacks fetched from drand. Each row has a **verify** button that runs the full check.
   Pasted round JSON can still be verified offline.

## Archive

A number cannot be turned back into a round, so the site keeps an archive in a Cloudflare D1
database. The Worker in `worker/index.mjs` runs every minute (cron trigger): it records every
round newer than the archive's last round, then backfills older rounds with whatever request
budget is left (`SUBREQUEST_BUDGET` in `wrangler.jsonc`; the Workers free plan allows 50
relay requests per run, paid plans 1000). Quicknet has produced about 33 million rounds since
August 2023, so full backfill takes a long time at the default budget; raise it on a paid plan.
A failed relay request stops that run's backfill at the failed round, so the archive never has
holes between its first and last round.

The archive only maps a number to a round and stores the round's randomness and signature. The
Worker checks `randomness = SHA-256(signature)` but not the BLS signature (that would exceed the
free plan's 10 ms of CPU per run); the page re-verifies the signature itself, so a wrong or
tampered archive row is rejected in the browser and never shown as genuine. Distinct rounds can
share a number (a few times per year of rounds), so a lookup by number returns every round that
produced it. Budget note: the whole tick is CPU-light (about 4 ms for 45 rounds in Node), but if
the Cloudflare logs show CPU-limit errors on the free plan, lower `SUBREQUEST_BUDGET`. D1 calls
count against a separate, higher limit and are not budgeted.

Each tick records when it started and how it ended in the `meta` table, and `/api/status` (and
the Verify tab) report it, so the cron's health is visible without log access.

API: `GET /api/status`, `GET /api/n/<16 digits>` (`{n, rounds: [...]}`, newest first),
`GET /api/round/<round>`, `GET /api/range?from=<round>&to=<round>` (at most 100 rounds).
Schema: `schema.sql`.

## Verify independently

```
python3 verify.py 33470004            # fetch the round, check it, derive N and factors
python3 verify.py --json round.json   # same, offline
python3 verify.py --check 33470004 47795929
python3 verify.py --check 33470004 accident gown swamp
python3 verify.py --vectors           # print derivations for test-vectors.json
```

`verify.py` uses only the standard library. `pip install py_ecc` enables the BLS signature
check; without it the script still checks `randomness == SHA-256(signature)` and says the
signature check was skipped.

## Layout

```
index.html              built page, self-contained (commit this)
SPEC.md                 normative derivation spec
verify.py               independent Python implementation
test-vectors.json       real quicknet rounds with signatures
worker/index.mjs        Cloudflare Worker: archive cron + /api/*, serves index.html
schema.sql              D1 schema for the archive
wrangler.jsonc          Cloudflare config (assets, D1 binding, cron, custom domains)
src/core.js             derivation, encoding, checking (no DOM)
src/index.template.html page markup and UI script
src/vendor-entry.js     what gets bundled from @noble/*
src/vendor.min.js       built bundle: @noble/curves 2.4.0 + @noble/hashes 2.4.0
src/wordlist.json       BIP39 English wordlist
build.mjs               assembles index.html from src/
test/vectors.mjs        JS derivation of test vectors (diff against verify.py --vectors)
test/browser_test.py    headless end-to-end test (playwright); archive API mocked
test/worker_test.mjs    Worker test: unit (archive tick) + wrangler dev integration (API)
```

## Build and test

```
npm install                       # only needed to rebuild vendor.min.js
npm run build:vendor              # esbuild → src/vendor.min.js
node build.mjs                    # → index.html
npm test                          # JS vs Python derivation must be identical
npm run test:worker               # archive tick + API against a mock relay (wrangler dev, local D1)
python3 test/browser_test.py --offline
npm run dev                       # local site + archive at http://localhost:8787 (GET /__scheduled runs the cron)
```

## Deploy

`wrangler.jsonc` deploys `index.html` as a static asset plus the archive Worker, with the D1
binding, the cron trigger, and the custom domains, to `randomsemiprime.com`. Cloudflare's Git
integration (Workers Builds) deploys on every push to the production branch; by hand:

```
npx wrangler d1 execute randomsemiprime-archive --remote --file schema.sql   # once
npx wrangler deploy          # needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or `npx wrangler login`
```

Only `index.html` is uploaded as an asset (see `.assetsignore`). Without the Worker, any static
host can serve `index.html`; the live ticker, capture, and verify-by-round-number still work,
and the page says the archive is unavailable.

## Trust model

- The beacon is unpredictable and publicly verifiable, so the number is fresh and not chosen
  by the tester.
- The derivation is public, so the factors are public too: anyone with the round number and
  the spec can compute them in milliseconds. This tool proves freshness; it does not prevent
  cheating with a hidden device. The test is only meaningful if the person being tested has
  no device and no confederate.
- The page never displays the factors; it only checks answers. That is a courtesy against
  shoulder-surfing, not a secret: anyone with the round number and the spec can compute them.

## License

MIT. Bundled: [@noble/curves](https://github.com/paulmillr/noble-curves) and
[@noble/hashes](https://github.com/paulmillr/noble-hashes) (MIT, Paul Miller);
BIP39 English wordlist (MIT, Bitcoin BIP39 authors).
