/* beacon-semiprime core — derivation, encoding, checking.
 * Spec: SPEC.md (v2). No DOM, no network. Requires globalThis.__noble.sha256
 * (Uint8Array -> Uint8Array) and globalThis.BIP39_WORDS (2048 strings).
 */
(function (root) {
  'use strict';

  // ---- Chain parameters (drand quicknet) ----
  const CHAIN = {
    hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
    publicKey: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
    genesisTime: 1692803367,
    period: 3,
    schemeID: 'bls-unchained-g1-rfc9380',
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
    relays: [
      'https://api.drand.sh',
      'https://api2.drand.sh',
      'https://api3.drand.sh',
      'https://drand.cloudflare.com',
    ],
  };

  // ---- Sizes (SPEC.md §2) ----
  // A size is the number of decimal digits of N; both factors have half as many. Every size is
  // derived from the same seed independently (the tag carries the digit count), so one round can
  // yield a number of each size. The page shows DEFAULT_DIGITS only.
  const MAX_CTR = 256;
  const MIN_FERMAT = 1000n;         // Fermat's method must need at least this many iterations (§3.3)

  function isqrt(n) {               // floor(sqrt(n)) for BigInt n >= 0
    if (n < 2n) return n;
    let x = BigInt(Math.floor(Math.sqrt(Number(n))));
    while (x * x > n) x--;
    while ((x + 1n) * (x + 1n) <= n) x++;
    return x;
  }
  function makeSize(digits, words, factorWords, groups) {
    if (digits % 2 || digits < 2 || digits > 16) throw new Error('digits must be even and at most 16');
    const fd = digits / 2;
    const HIGH = 10n ** BigInt(fd);                         // factors are strictly below this
    const LOW = isqrt(10n ** BigInt(digits - 1) - 1n) + 1n; // ceil(sqrt(10^(digits-1))): p*q >= 10^(digits-1)
    const RANGE = HIGH - LOW;
    const LIMIT = (2n ** 32n / RANGE) * RANGE;              // rejection threshold for the 32-bit sample
    const WORD_MAX = 1n << BigInt(11 * words);              // N must fit in `words` words
    if (WORD_MAX <= 10n ** BigInt(digits - 1)) throw new Error('word count too small for ' + digits + ' digits');
    if ((1n << BigInt(11 * factorWords)) < HIGH) throw new Error('factor word count too small for ' + fd + '-digit factors');
    if (groups.reduce((a, b) => a + b, 0) !== digits) throw new Error('digit groups must add up to ' + digits);
    return { digits, factorDigits: fd, words, factorWords, groups, LOW, HIGH, RANGE, LIMIT, WORD_MAX };
  }
  const SIZES = {
    10: makeSize(10, 3, 2, [3, 3, 4]),     // 5-digit factors; N < 2^33 so it fits 3 words; a factor fits 2
    16: makeSize(16, 5, 3, [4, 4, 4, 4]),  // 8-digit factors; N < 10^16 < 2^55 always fits 5 words; a factor fits 3
  };
  const DEFAULT_DIGITS = 10;
  function size(digits) {
    const s = SIZES[digits === undefined ? DEFAULT_DIGITS : digits];
    if (!s) throw new Error('unsupported size: ' + digits + ' digits');
    return s;
  }

  // Primes below 10^4 — trial division with these is exact for n < 10^8, i.e. for every factor size.
  const SMALL_PRIMES = (function () {
    const n = 10000, s = new Uint8Array(n + 1), out = [];
    for (let i = 2; i <= n; i++) {
      if (s[i]) continue;
      out.push(BigInt(i));
      for (let j = i * i; j <= n; j += i) s[j] = 1;
    }
    return out; // 1229 primes
  })();

  // Trial division is done in Number arithmetic, which is exact below 2^53 and much faster than
  // BigInt; every value here is below 10^8 + 10^4.
  const SMALL_PRIMES_NUM = SMALL_PRIMES.map(Number);
  function isPrimeNum(x) {          // exact for 0 <= x < 10^8
    if (x < 2) return false;
    for (let i = 0; i < SMALL_PRIMES_NUM.length; i++) {
      const p = SMALL_PRIMES_NUM[i];
      if (p * p > x) return true;
      if (x % p === 0) return x === p;
    }
    return true;
  }
  function isPrime(n) { return isPrimeNum(Number(n)); }   // n: BigInt or Number, 0 <= n < 10^8

  function nextPrime(n) {           // smallest prime >= n (BigInt in, BigInt out)
    let x = Number(n);
    while (!isPrimeNum(x)) x++;
    return BigInt(x);
  }

  function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) throw new Error('bad hex');
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(b) { return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }

  function sha256(bytes) { return root.__noble.sha256(bytes); }

  function concat() {
    let n = 0; for (const a of arguments) n += a.length;
    const out = new Uint8Array(n); let o = 0;
    for (const a of arguments) { out.set(a, o); o += a.length; }
    return out;
  }

  // farApart(p, q): Fermat's method, started at ceil(sqrt(pq)), reaches (p+q)/2 after
  // (p+q)/2 - sqrt(pq) iterations; require at least MIN_FERMAT of them (SPEC.md §3.3).
  // (p+q)/2 - sqrt(pq) >= S  <=>  p+q-2S >= 0 and (p+q-2S)^2 >= 4pq, exactly in integers.
  function farApart(p, q) {
    const s = p + q - 2n * MIN_FERMAT;
    return s >= 0n && s * s >= 4n * p * q;
  }

  // derivePrime(seed, tag, sz, accept) — SPEC.md §3.2. `accept(f)` may reject a candidate prime.
  function derivePrime(seed, tag, sz, accept) {
    const tagBytes = new TextEncoder().encode(tag);
    for (let ctr = 0; ctr < MAX_CTR; ctr++) {
      const h = sha256(concat(seed, tagBytes, Uint8Array.of(ctr)));
      const x = (BigInt(h[0]) << 24n) | (BigInt(h[1]) << 16n) | (BigInt(h[2]) << 8n) | BigInt(h[3]);
      if (x >= sz.LIMIT) continue;
      const p = nextPrime(sz.LOW + (x % sz.RANGE));
      if (p >= sz.HIGH) continue;
      if (!accept(p)) continue;
      return p;
    }
    throw new Error('derivePrime: counter exhausted');
  }

  // deriveFactors(seedHex, digits) -> {p, q}   (both BigInt; p from tag "p<digits>", q from "q<digits>")
  // The seed is the round's randomness for the public number, or personalSeed() for a personal one.
  function deriveFactors(seedHex, digits) {
    const sz = size(digits);
    const seed = hexToBytes(seedHex);
    if (seed.length !== 32) throw new Error('seed must be 32 bytes');
    const p = derivePrime(seed, 'p' + sz.digits, sz, () => true);
    const q = derivePrime(seed, 'q' + sz.digits, sz, f => f !== p && p * f < sz.WORD_MAX && farApart(p, f));
    return { p, q };
  }

  // deriveN(seedHex, digits) -> BigInt. Factors are not retained.
  function deriveN(seedHex, digits) {
    const f = deriveFactors(seedHex, digits);
    return f.p * f.q;
  }

  // ---- Personal numbers (SPEC.md §8) ----
  // personalSeed(randomnessHex, passphrase) -> hex of SHA-256(domain ‖ randomness ‖ UTF-8(NFC(passphrase))).
  // The domain string keeps it apart from the public number; the passphrase is normalized but
  // neither trimmed nor case-folded, so the same characters always give the same number.
  const PERSONAL_DOMAIN = 'beacon-semiprime personal v2';
  function personalSeed(randomnessHex, passphrase) {
    const seed = hexToBytes(randomnessHex);
    if (seed.length !== 32) throw new Error('randomness must be 32 bytes');
    const enc = new TextEncoder();
    return bytesToHex(sha256(concat(enc.encode(PERSONAL_DOMAIN), seed, enc.encode(String(passphrase).normalize('NFC')))));
  }
  function derivePersonalN(randomnessHex, passphrase, digits) { return deriveN(personalSeed(randomnessHex, passphrase), digits); }

  // ---- Round / time ----
  function roundAt(unixSeconds) {   // current round number at a given time
    if (unixSeconds < CHAIN.genesisTime) return 0;
    return Math.floor((unixSeconds - CHAIN.genesisTime) / CHAIN.period) + 1;
  }
  function roundTime(round) {       // unix seconds at which round became available
    return CHAIN.genesisTime + (round - 1) * CHAIN.period;
  }
  function roundToBytes(round) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(round));
    return b;
  }
  // Message that the quicknet nodes sign for a round: SHA-256(round as 8-byte BE)
  function roundMessage(round) { return sha256(roundToBytes(round)); }

  // randomness must equal SHA-256(signature)
  function randomnessMatches(randomnessHex, signatureHex) {
    return bytesToHex(sha256(hexToBytes(signatureHex))) === randomnessHex.toLowerCase();
  }

  // ---- Wordlist encoding (SPEC.md §4) ----
  function words() { return root.BIP39_WORDS; }
  const WORD_INDEX = (function () {
    const m = new Map();
    return function () {
      if (m.size === 0) words().forEach((w, i) => m.set(w, i));
      return m;
    };
  })();

  function encodeWords(n, count) {  // n: BigInt, count: number of 11-bit words, big-endian
    if (n < 0n || n >= (1n << BigInt(11 * count))) throw new Error('value out of range for word count');
    const out = [];
    for (let i = count - 1; i >= 0; i--) out.push(words()[Number((n >> BigInt(11 * i)) & 2047n)]);
    return out;
  }
  function encodeN(n, digits) { return encodeWords(n, size(digits).words); }
  function encodeFactor(f, digits) { return encodeWords(f, size(digits).factorWords); }

  // Resolve a typed word to its index: exact match, else unique prefix of >= 4 letters.
  function wordToIndex(w) {
    w = w.toLowerCase();
    const idx = WORD_INDEX();
    if (idx.has(w)) return idx.get(w);
    if (w.length >= 4) {
      const hits = words().filter(x => x.startsWith(w));
      if (hits.length === 1) return idx.get(hits[0]);
    }
    return -1;
  }
  function decodeWords(ws) {        // array of words -> BigInt, or throws
    let n = 0n;
    for (const w of ws) {
      const i = wordToIndex(w);
      if (i < 0) throw new Error('unknown word: ' + w);
      n = (n << 11n) | BigInt(i);
    }
    return n;
  }

  // ---- Answer parsing / checking (SPEC.md §5) ----
  // Input: free text. Digits-only tokens are decimal factors. Word tokens are grouped by the
  // size's factor word count. Separators: whitespace , ; × * and an x between digits or standing
  // alone (never inside a word such as "expose"). Returns {factors: BigInt[]} or throws with a
  // readable message.
  function parseAnswer(text, digits) {
    const fw = size(digits).factorWords;
    const tokens = text.trim().replace(/(\d)x(?=\d)/gi, '$1 ').split(/[\s,;×*]+/).filter(t => t && !/^x$/i.test(t));
    if (!tokens.length) throw new Error('enter one or two factors');
    const factors = [];
    let wordBuf = [];
    const flush = () => {
      if (!wordBuf.length) return;
      if (wordBuf.length % fw) throw new Error('word factors are ' + fw + ' words each (got ' + wordBuf.length + ' words)');
      for (let i = 0; i < wordBuf.length; i += fw) factors.push(decodeWords(wordBuf.slice(i, i + fw)));
      wordBuf = [];
    };
    for (const t of tokens) {
      if (/^\d+$/.test(t)) { flush(); factors.push(BigInt(t)); }
      else if (/^[a-zA-Z]+$/.test(t)) wordBuf.push(t);
      else throw new Error('unrecognized token: ' + t);
    }
    flush();
    if (factors.length > 2) throw new Error('at most two factors');
    return { factors };
  }

  // checkFactors(N, factors) -> {ok, each: [{f, ok}], complete, reason}
  // Each factor is judged on its own: correct iff 1 < f < N and f divides N (checked by
  // division only; the factors of N are never computed). With two factors, `complete` is
  // whether their product is N, i.e. both prime factors were given. Nothing is revealed
  // beyond whether each entered value divides N.
  function checkFactors(N, factors) {
    const each = factors.map(f => ({ f, ok: f > 1n && f < N && N % f === 0n }));
    const good = each.filter(e => e.ok).length;
    if (factors.length === 1) {
      return each[0].ok ? { ok: true, each, complete: false }
                        : { ok: false, each, complete: false, reason: 'does not divide N' };
    }
    const complete = factors[0] * factors[1] === N;
    if (complete) return { ok: true, each, complete };
    if (good === 2) return { ok: false, each, complete, reason: 'both divide N but their product is not N (the same factor twice)' };
    if (good === 1) return { ok: false, each, complete, reason: 'one factor divides N, the other does not' };
    return { ok: false, each, complete, reason: 'neither divides N' };
  }
  // checkAnswer(N, factors) -> {ok, reason}: one factor must divide N; two must multiply to N.
  function checkAnswer(N, factors) {
    const r = checkFactors(N, factors);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  // formatN(N, digits): the digits in the size's groups, e.g. 1234567890 -> "123 456 7890"
  function formatN(N, digits) {
    const s = N.toString(), out = [];
    let i = 0;
    for (const g of size(digits).groups) { out.push(s.slice(i, i + g)); i += g; }
    return out.join(' ');
  }

  root.SP = {
    CHAIN, SIZES, DEFAULT_DIGITS, MIN_FERMAT, SMALL_PRIMES, size,
    isPrime, nextPrime, farApart, derivePrime, deriveFactors, deriveN, personalSeed, derivePersonalN, PERSONAL_DOMAIN,
    roundAt, roundTime, roundToBytes, roundMessage, randomnessMatches,
    encodeN, encodeFactor, encodeWords, decodeWords, wordToIndex,
    parseAnswer, checkAnswer, checkFactors, formatN, hexToBytes, bytesToHex,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
