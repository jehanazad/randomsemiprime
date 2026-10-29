# beacon-semiprime specification, version 1

This document is normative. An implementation conforms if, for every drand quicknet round,
it produces the same `N`, the same words, and the same accept/reject decisions as described here.
Test vectors are in `test-vectors.json`; `verify.py` and `src/core.js` are two independent
implementations that must agree on them.

## 1. Beacon

- Network: drand, chain **quicknet**
- Chain hash: `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`
- Scheme: `bls-unchained-g1-rfc9380` (signatures in G1, public key in G2, BLS12-381)
- Public key (G2, compressed, hex):
  `83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a`
- Genesis time: `1692803367` (Unix seconds); period: `3` s
- Round `r` (r ≥ 1) becomes available at `genesis + (r − 1) · 3`.
- A round is a triple `(round, randomness, signature)` where `randomness` is 32 bytes and
  `signature` is a 48-byte compressed G1 point, both hex-encoded.

A round is **valid** iff both hold:

1. `signature` is a valid BLS signature under the chain public key on the message
   `SHA-256(round as 8-byte big-endian unsigned integer)`, using hash-to-curve
   `BLS12381G1_XMD:SHA-256_SSWU_RO_` with domain separation tag
   `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_`.
2. `randomness == SHA-256(signature bytes)`.

Implementations MUST refuse to display a number for a round that is not valid.

## 2. Constants

| name    | value         | meaning                                              |
|---------|---------------|------------------------------------------------------|
| LOW     | 31 622 777    | ⌈√10 · 10⁷⌉; the smallest 8-digit factor allowed     |
| HIGH    | 100 000 000   | 10⁸; factors are strictly below this                 |
| RANGE   | 68 377 223    | HIGH − LOW                                           |
| LIMIT   | 4 239 387 826 | ⌊2³² / RANGE⌋ · RANGE; rejection-sampling threshold  |
| MAX_CTR | 256           | counter bound (never reached in practice)            |

Because both factors are ≥ LOW, `N = p·q ≥ LOW² > 10¹⁵`, and because both are < 10⁸,
`N < 10¹⁶`. So `N` always has exactly 16 decimal digits.

## 3. Derivation

### 3.1 Primality

`isPrime(n)` for `0 ≤ n < 10⁸` is defined by trial division by every prime below 10⁴
(there are 1 229 of them). This is exact in that range; no probabilistic test is used.
`nextPrime(n)` is the smallest prime ≥ n.

### 3.2 derivePrime(seed, tag, exclude)

`seed` is the 32 randomness bytes. `tag` is the ASCII string `"p"` or `"q"`.
`exclude` is either nothing or an integer to avoid.

```
for ctr in 0 .. MAX_CTR−1:
    h = SHA-256( seed ‖ tag ‖ byte(ctr) )          # 32 + 1 + 1 = 34 input bytes
    x = big-endian unsigned integer of h[0..4)      # 0 ≤ x < 2^32
    if x ≥ LIMIT:            continue               # rejection: keeps x mod RANGE uniform
    cand = LOW + (x mod RANGE)
    f = nextPrime(cand)
    if f ≥ HIGH:             continue               # ran off the top of the range
    if f == exclude:         continue
    return f
error
```

### 3.3 Factors and N

```
p = derivePrime(seed, "p", none)
q = derivePrime(seed, "q", p)
N = p · q
```

`p` and `q` are not ordered; `p` is simply the one derived with tag `"p"`.

## 4. Word encoding

The wordlist is the BIP39 English list (2 048 words, `src/wordlist.json`,
SHA-256 of the newline-joined list with trailing newline:
`2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`).
This is a base-2048 encoding using that list; it is **not** a BIP39 mnemonic and has no checksum.

- `N` (< 2⁵⁴ < 2⁵⁵) is written as a 55-bit big-endian integer and split into 5 groups of 11 bits,
  most significant group first. Each group indexes the wordlist.
- A factor (< 10⁸ < 2²⁷ < 2³³) is written as a 33-bit big-endian integer and split into 3 groups.

Decoding is the inverse. When reading words typed by a person, an implementation MAY accept
any prefix of 4 or more letters that matches exactly one word (the BIP39 list guarantees the
first four letters are unique), and MUST ignore letter case.

## 5. Answer checking

An answer is one or two factors, each given either as a decimal integer or as three words.

- One factor `f`: accepted iff `1 < f < N` and `N mod f == 0`.
  (Because `N` is a semiprime, any such `f` is `p` or `q`.)
- Two factors `a, b`: accepted iff `a > 1`, `b > 1`, and `a · b == N`.

## 6. Transcript

An exported session is JSON with `spec: "beacon-semiprime v1"`, the chain hash, and a list of
entries each carrying the round's `(round, randomness, signature)`, `N`, the answer text, the
parsed factors, the verdict, and elapsed milliseconds. Anyone can re-derive every `N` from the
embedded rounds and re-check every signature against the chain public key.

## 7. Test vectors

See `test-vectors.json`. Expected results:

| round      | p          | q          | N                  | N words                               |
|------------|------------|------------|--------------------|---------------------------------------|
| 1          | 90 234 649 | 97 151 699 | 8766449459018651   | dinner expose angry similar inflict   |
| 20 000 000 | 66 752 887 | 42 583 421 | 2842566290086427   | before network eager tiny drop        |
| 33 470 004 | 47 795 929 | 69 206 453 | 3307786713929837   | bleak allow asthma example asset      |
