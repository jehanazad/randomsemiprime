# beacon-semiprime specification, version 2

This document is normative. An implementation conforms if, for every drand quicknet round and
every defined size, it produces the same `N`, the same words, and the same accept/reject
decisions as described here. Test vectors are in `test-vectors.json`; `verify.py` and
`src/core.js` are two independent implementations that must agree on them.

Version 2 replaces version 1 (16-digit numbers only, 5 words, no gap rule). The two produce
different numbers for the same round; a v1 number can be recognised by its length.

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

## 2. Sizes and constants

A **size** is the number of decimal digits `D` of `N` (even). Both factors have `D/2` digits.
Each size has its own constants, all determined by `D` except the word counts:

| name     | value                              | meaning                                                   |
|----------|------------------------------------|-----------------------------------------------------------|
| HIGH     | 10^(D/2)                           | factors are strictly below this                           |
| LOW      | ⌈√(10^(D−1))⌉                      | the smallest factor allowed, so that `p·q ≥ 10^(D−1)`     |
| RANGE    | HIGH − LOW                         |                                                           |
| LIMIT    | ⌊2³² / RANGE⌋ · RANGE              | rejection-sampling threshold                              |
| WORDS    | (per size)                         | words that encode `N`; `N` MUST be below `WORD_MAX`       |
| WORD_MAX | 2^(11 · WORDS)                     |                                                           |
| FWORDS   | (per size)                         | words that encode a factor; `2^(11 · FWORDS) ≥ HIGH`      |

Constants shared by all sizes: `MAX_CTR = 256` (counter bound, never reached in practice) and
`MIN_FERMAT = 1000` (§3.3).

Defined sizes:

| D  | LOW        | HIGH        | RANGE      | LIMIT         | WORDS | WORD_MAX       | FWORDS |
|----|------------|-------------|------------|---------------|-------|----------------|--------|
| 10 | 31 623     | 100 000     | 68 377     | 4 294 964 501 | 3     | 2³³ = 8 589 934 592 | 2 |
| 16 | 31 622 777 | 100 000 000 | 68 377 223 | 4 239 387 826 | 5     | 2⁵⁵            | 3      |

Because both factors are ≥ LOW, `N = p·q ≥ 10^(D−1)`, and because both are < HIGH, `N < 10^D`:
`N` always has exactly `D` digits. For `D = 10` the word bound is a real constraint (a 10-digit
number fits 3 words only below 2³³) and §3.3 enforces it; for `D = 16` every `N` fits.

The displayed size is 10. Sizes are derived independently from the same randomness (the tag in
§3.2 carries `D`), so one round can yield a number of every size.

## 3. Derivation

### 3.1 Primality

`isPrime(n)` for `0 ≤ n < 10⁸` is defined by trial division by every prime below 10⁴
(there are 1 229 of them). This is exact in that range, which covers every defined size; no
probabilistic test is used. `nextPrime(n)` is the smallest prime ≥ n.

### 3.2 derivePrime(seed, tag, accept)

`seed` is the 32 randomness bytes. `tag` is the ASCII string `"p"` or `"q"` followed by the
decimal digits of `D` (`"p10"`, `"q10"`, `"p16"`, `"q16"`). `accept` is a predicate on the
candidate prime.

```
for ctr in 0 .. MAX_CTR−1:
    h = SHA-256( seed ‖ tag ‖ byte(ctr) )          # 32 + len(tag) + 1 input bytes
    x = big-endian unsigned integer of h[0..4)      # 0 ≤ x < 2^32
    if x ≥ LIMIT:            continue               # rejection: keeps x mod RANGE uniform
    cand = LOW + (x mod RANGE)
    f = nextPrime(cand)
    if f ≥ HIGH:             continue               # ran off the top of the range
    if not accept(f):        continue
    return f
error
```

### 3.3 Factors and N

```
p = derivePrime(seed, "p"+D, accept = always)
q = derivePrime(seed, "q"+D, accept = f ↦ f ≠ p  and  p·f < WORD_MAX  and  farApart(p, f))
N = p · q
```

`farApart(p, q)` is the gap rule. Fermat's method, started at ⌈√N⌉, reaches `(p+q)/2` after
`(p+q)/2 − √(p·q)` iterations, so factors that are close together make `N` easy to factor by
hand. The rule requires at least `MIN_FERMAT` iterations:

```
farApart(p, q)  :=  (p + q)/2 − √(p·q) ≥ MIN_FERMAT
                 ⟺  s ≥ 0  and  s² ≥ 4·p·q      where  s = p + q − 2·MIN_FERMAT
```

The second form is exact in integer arithmetic and is the one implementations use.
For `D = 10` this amounts to the larger factor exceeding the smaller by a ratio of roughly
1.4 to 1.6, and it rejects a little over half of all candidate pairs; for `D = 16` it rejects
about 2 %. With `MAX_CTR = 256` the counter is never exhausted in practice.

`p` and `q` are not ordered; `p` is simply the one derived with the `"p"` tag.

## 4. Word encoding

The wordlist is the BIP39 English list (2 048 words, `src/wordlist.json`,
SHA-256 of the newline-joined list with trailing newline:
`2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`).
This is a base-2048 encoding using that list; it is **not** a BIP39 mnemonic and has no checksum.

- `N` is written as an `11 · WORDS`-bit big-endian integer and split into `WORDS` groups of
  11 bits, most significant group first. Each group indexes the wordlist. (`N < WORD_MAX` by
  §3.3, so it fits.)
- A factor is written as an `11 · FWORDS`-bit big-endian integer and split into `FWORDS` groups.

Decoding is the inverse. When reading words typed by a person, an implementation MAY accept
any prefix of 4 or more letters that matches exactly one word (the BIP39 list guarantees the
first four letters are unique), and MUST ignore letter case.

Displayed digits are grouped for reading: `3 3 4` for `D = 10` (`236 939 3317`), `4 4 4 4`
for `D = 16`. Grouping is presentation only; any spacing MUST be accepted on input.

## 5. Answer checking

An answer is one or two factors, each given either as a decimal integer or as `FWORDS` words.

- One factor `f`: accepted iff `1 < f < N` and `N mod f == 0`.
  (Because `N` is a semiprime, any such `f` is `p` or `q`.)
- Two factors `a, b`: accepted iff `a > 1`, `b > 1`, and `a · b == N`. If exactly one of them
  divides `N`, or both do but `a · b ≠ N` (the same factor twice), an implementation SHOULD say
  which, as the page does.

## 6. Archive

A row of the archive maps a round to its `N` of the displayed size, stored as text, together
with the round's randomness and signature. A row whose `N` has a different number of digits
was stored under another size or spec version; it is re-derived from its randomness
(`worker/index.mjs`, `migrateRows`). Readers MUST re-derive `N` from the randomness rather than
trust the stored text, as the page does.

## 7. Test vectors

See `test-vectors.json`: three real rounds, derived at every size in its `sizes` list.
Expected results:

| round      | D  | p          | q          | N                | N words                               |
|------------|----|------------|------------|------------------|---------------------------------------|
| 1          | 10 | 47 317     | 82 963     | 3925560271       | insane unfold ketchup                 |
| 1          | 16 | 65 133 637 | 77 996 671 | 5080206856122427 | catch shop tunnel column alter        |
| 20 000 000 | 10 | 50 989     | 73 433     | 3744275237       | hurdle refuse gorilla                 |
| 20 000 000 | 16 | 90 958 121 | 45 780 571 | 4164114716467091 | budget record scorpion tuna venue     |
| 33 470 004 | 10 | 73 037     | 32 441     | 2369393317       | educate tribe feed                    |
| 33 470 004 | 16 | 60 465 767 | 36 170 291 | 2187064387928197 | auto faint social ship awful          |

Factor words (`D = 10`): 47317 = `actual boy`, 82963 = `agree list`, 50989 = `adapt toss`,
73433 = `afford swamp`, 73037 = `afford predict`, 32441 = `acid strong`.
