# beacon-semiprime

A fresh 16-digit semiprime every 3 seconds, derived deterministically from the
[drand](https://drand.love) quicknet randomness beacon, for live tests of mental factoring.

Because each number is a fixed function of a signed, timestamped beacon round that nobody
can predict, the number shown at any moment could not have been known in advance, and
anyone can later recompute it from the round and check the beacon's signature.

## Use

Open `index.html` — from a web server, GitHub Pages, or directly as a file. It needs
network access to a drand relay (`api.drand.sh`, `api2.drand.sh`, `api3.drand.sh`,
`drand.cloudflare.com`) for the live ticker; everything else runs in the browser.

1. **Live** shows the number from the round that was current when you arrived, as 16 digits and
   as 5 words. It stays put so it can be read calmly; new rounds keep arriving every 3 s in the
   **Recent rounds** list below it (newest first, last 200 kept). **Update** replaces the shown
   number with the newest round. Press **Capture** to freeze the shown number and start the clock.
2. Enter the answer: one or two factors, as 8-digit numbers or 3 words each. **Check** records
   the result and time in the session log. **Reveal** recomputes the factors on demand.
3. **Export JSON** (or **Copy JSON** where downloads are blocked) saves a transcript containing
   each round's signature, so a third party can verify everything offline.
4. **Verify a round** re-derives any round by number, or from pasted round JSON with no network.
   It can also **look up** the number that was showing at a given date and time (local time or
   UTC): the time is mapped to its quicknet round, which is then fetched and verified.

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
src/core.js             derivation, encoding, checking (no DOM)
src/index.template.html page markup and UI script
src/vendor-entry.js     what gets bundled from @noble/*
src/vendor.min.js       built bundle: @noble/curves 2.4.0 + @noble/hashes 2.4.0
src/wordlist.json       BIP39 English wordlist
build.mjs               assembles index.html from src/
test/vectors.mjs        JS derivation of test vectors (diff against verify.py --vectors)
test/browser_test.py    headless end-to-end test (playwright)
```

## Build and test

```
npm install                       # only needed to rebuild vendor.min.js
npm run build:vendor              # esbuild → src/vendor.min.js
node build.mjs                    # → index.html
npm test                          # JS vs Python derivation must be identical
python3 test/browser_test.py --offline
```

## Deploy

The site is the single file `index.html`; there is no server. On Cloudflare Pages connect this
repository with build command `node build.mjs` and build output directory `/` (root), or skip
the build and serve the committed `index.html` as a static asset. Any static host works.

## Trust model

- The beacon is unpredictable and publicly verifiable, so the number is fresh and not chosen
  by the tester.
- The derivation is public, so the factors are public too: anyone with the round number and
  the spec can compute them in milliseconds. This tool proves freshness; it does not prevent
  cheating with a hidden device. The test is only meaningful if the person being tested has
  no device and no confederate.
- Factors are not written into the page until Reveal is pressed. That is a courtesy against
  shoulder-surfing, not a secret.

## License

MIT. Bundled: [@noble/curves](https://github.com/paulmillr/noble-curves) and
[@noble/hashes](https://github.com/paulmillr/noble-hashes) (MIT, Paul Miller);
BIP39 English wordlist (MIT, Bitcoin BIP39 authors).
