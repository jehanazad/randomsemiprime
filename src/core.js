/* beacon-semiprime core — derivation, encoding, checking.
 * Spec: SPEC.md (v1). No DOM, no network. Requires globalThis.__noble.sha256
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

  // ---- Derivation constants (SPEC.md §3) ----
  const LOW = 31622777n;            // ceil(sqrt(10) * 10^7): p*q >= 10^15
  const HIGH = 100000000n;          // 10^8: factors are 8 digits
  const RANGE = HIGH - LOW;         // 68377223
  const LIMIT = (2n ** 32n / RANGE) * RANGE; // 4239387826, rejection threshold
  const MAX_CTR = 256;

  // Primes below 10^4 — trial division with these is exact for n < 10^8.
  const SMALL_PRIMES = (function () {
    const n = 10000, s = new Uint8Array(n + 1), out = [];
    for (let i = 2; i <= n; i++) {
      if (s[i]) continue;
      out.push(BigInt(i));
      for (let j = i * i; j <= n; j += i) s[j] = 1;
    }
    return out; // 1229 primes
  })();

  function isPrime(n) {             // exact for 0 <= n < 10^8
    if (n < 2n) return false;
    for (const p of SMALL_PRIMES) {
      if (p * p > n) return true;
      if (n % p === 0n) return n === p;
    }
    return true;
  }

  function nextPrime(n) {           // smallest prime >= n
    while (!isPrime(n)) n += 1n;
    return n;
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

  // derivePrime(seed, tag, exclude) — SPEC.md §3.2
  function derivePrime(seed, tag, exclude) {
    const tagBytes = new TextEncoder().encode(tag);
    for (let ctr = 0; ctr < MAX_CTR; ctr++) {
      const h = sha256(concat(seed, tagBytes, Uint8Array.of(ctr)));
      const x = (BigInt(h[0]) << 24n) | (BigInt(h[1]) << 16n) | (BigInt(h[2]) << 8n) | BigInt(h[3]);
      if (x >= LIMIT) continue;
      const p = nextPrime(LOW + (x % RANGE));
      if (p >= HIGH) continue;
      if (exclude !== null && p === exclude) continue;
      return p;
    }
    throw new Error('derivePrime: counter exhausted');
  }

  // deriveFactors(randomnessHex) -> {p, q}   (both BigInt, p from tag "p", q from tag "q")
  function deriveFactors(randomnessHex) {
    const seed = hexToBytes(randomnessHex);
    if (seed.length !== 32) throw new Error('randomness must be 32 bytes');
    const p = derivePrime(seed, 'p', null);
    const q = derivePrime(seed, 'q', p);
    return { p, q };
  }

  // deriveN(randomnessHex) -> BigInt. Factors are not retained.
  function deriveN(randomnessHex) {
    const f = deriveFactors(randomnessHex);
    return f.p * f.q;
  }

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
  function encodeN(n) { return encodeWords(n, 5); }       // 16-digit N < 2^54 -> 5 words
  function encodeFactor(f) { return encodeWords(f, 3); }  // 8-digit factor < 2^27 -> 3 words

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
  // Input: free text. Digits-only tokens are decimal factors. Word tokens are grouped in threes.
  // Separators: whitespace , ; × * and an x between digits (never inside a word such as "expose").
  // Returns {factors: BigInt[]} or throws with a readable message.
  function parseAnswer(text) {
    const tokens = text.trim().replace(/(\d)\s*x\s*(\d)/gi, '$1 $2').split(/[\s,;×*]+/).filter(Boolean);
    if (!tokens.length) throw new Error('enter one or two factors');
    const factors = [];
    let wordBuf = [];
    const flush = () => {
      if (!wordBuf.length) return;
      if (wordBuf.length % 3) throw new Error('word factors are 3 words each (got ' + wordBuf.length + ' words)');
      for (let i = 0; i < wordBuf.length; i += 3) factors.push(decodeWords(wordBuf.slice(i, i + 3)));
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

  // checkAnswer(N, factors) -> {ok, reason}
  function checkAnswer(N, factors) {
    if (factors.length === 1) {
      const f = factors[0];
      if (f <= 1n || f >= N) return { ok: false, reason: 'factor must be between 1 and N' };
      return N % f === 0n ? { ok: true } : { ok: false, reason: 'does not divide N' };
    }
    const [a, b] = factors;
    if (a <= 1n || b <= 1n) return { ok: false, reason: 'factors must be greater than 1' };
    return a * b === N ? { ok: true } : { ok: false, reason: 'product is not N' };
  }

  function groupDigits(s, n) {      // "1234567890123456" -> "1234 5678 9012 3456"
    const out = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out.join(' ');
  }

  root.SP = {
    CHAIN, LOW, HIGH, RANGE, LIMIT, SMALL_PRIMES,
    isPrime, nextPrime, derivePrime, deriveFactors, deriveN,
    roundAt, roundTime, roundToBytes, roundMessage, randomnessMatches,
    encodeN, encodeFactor, encodeWords, decodeWords, wordToIndex,
    parseAnswer, checkAnswer, groupDigits, hexToBytes, bytesToHex,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
