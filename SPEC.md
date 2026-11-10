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

A **size** is the number of decimal digits `D` of `N`. Both factors lie in the same range, around
`√N`, so the semiprime is balanced. Each size has its own constants, determined by `D` and three
per-size choices (the two word counts and the Fermat minimum):

| name       | value                                   | meaning                                                  |
|------------|-----------------------------------------|----------------------------------------------------------|
| LOW        | ⌈√(10^(D−1))⌉                           | the smallest factor allowed, so that `p·q ≥ 10^(D−1)`    |
| HIGH       | min( ⌈√(10^D)⌉ , 2^(11 · FWORDS) )      | factors are strictly below this: `p·q < 10^D`, and a factor fits its words |
| RANGE      | HIGH − LOW                              |                                                          |
| LIMIT      | ⌊2³² / RANGE⌋ · RANGE                   | rejection-sampling threshold                             |
| WORDS      | (per size)                              | words that encode `N`; `N` MUST be below `WORD_MAX`      |
| WORD_MAX   | 2^(11 · WORDS)                          |                                                          |
| FWORDS     | (per size)                              | words that encode a factor                               |
| MIN_FERMAT | (per size)                              | least number of Fermat iterations (§3.3)                 |

Shared by all sizes: `MAX_CTR = 256` (counter bound, never reached in practice). For even `D`
the bounds are the familiar `⌈√10 · 10^(D/2−1)⌉` and `10^(D/2)`; for odd `D` the factors
straddle `√(10^D)`.

Defined sizes:

| D  | LOW        | HIGH        | RANGE      | LIMIT         | WORDS | FWORDS | MIN_FERMAT | note |
|----|------------|-------------|------------|---------------|-------|--------|------------|------|
| 5  | 100        | 317         | 217        | 4 294 967 185 | 2     | 1      | 5          | 40 primes |
| 7  | 1 000      | 2 048       | 1 048      | 4 294 966 304 | 2     | 1      | 20         | HIGH capped by FWORDS; 141 primes; `N < 2²²` always |
| 8  | 3 163      | 10 000      | 6 837      | 4 294 965 582 | 3     | 2      | 100        | |
| 10 | 31 623     | 100 000     | 68 377     | 4 294 964 501 | 3     | 2      | 1 000      | `N < 2³³` is a real constraint |
| 12 | 316 228    | 1 000 000   | 683 772    | 4 294 950 744 | 4     | 2      | 8 000      | |
| 14 | 3 162 278  | 10 000 000  | 6 837 722  | 4 294 894 576 | 5     | 3      | 60 000     | |
| 16 | 31 622 777 | 100 000 000 | 68 377 223 | 4 239 387 826 | 5     | 3      | 700 000    | |

`N` always has exactly `D` digits. Where `WORD_MAX ≤ 10^D` (only `D = 10` among these) the
word bound is a real constraint and §3.3 enforces it; elsewhere every `N` fits.

The **tiers** offered on the page and stored in the archive are `5, 7, 10, 16`; 10 is the
default. Sizes are derived independently from the same randomness (the tag in §3.2 carries `D`),
so one round yields a number of every size.

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
hand. The rule requires at least the size's `MIN_FERMAT` iterations:

```
farApart(p, q)  :=  (p + q)/2 − √(p·q) ≥ MIN_FERMAT
                 ⟺  s ≥ 0  and  s² ≥ 4·p·q      where  s = p + q − 2·MIN_FERMAT
```

The second form is exact in integer arithmetic and is the one implementations use. Each
`MIN_FERMAT` is set near the median number of trial divisions for its size, so that Fermat is
never the easier path; it rejects roughly half of all candidate pairs at every size. With
`MAX_CTR = 256` the counter is never exhausted in practice.

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

Displayed digits are grouped for reading: `5` for `D = 5`, `3 4` for `D = 7`, `3 3 4` for
`D = 10` (`236 939 3317`), `4 4 4 4` for `D = 16`. Grouping is presentation only; any spacing
MUST be accepted on input. The digit count of a typed number, or the decoded value of typed
words, identifies its size: the ranges of the tiers do not overlap.

## 5. Answer checking

An answer is one or two factors, each given either as a decimal integer or as `FWORDS` words.

- One factor `f`: accepted iff `1 < f < N` and `N mod f == 0`.
  (Because `N` is a semiprime, any such `f` is `p` or `q`.)
- Two factors `a, b`: accepted iff `a > 1`, `b > 1`, and `a · b == N`. If exactly one of them
  divides `N`, or both do but `a · b ≠ N` (the same factor twice), an implementation SHOULD say
  which, as the page does.

## 6. Archive

A row of the archive maps a round to its `N` at every tier (columns `n5`, `n7`, `n10`,
`n16`, stored as text), together with the round's randomness and signature. Readers MUST re-derive `N` from the randomness
rather than trust the stored text, as the page does.

## 7. Personal numbers

A personal number is derived from a round and a passphrase chosen by the user, so that it is
unknown to anyone who has not seen the passphrase while keeping the round's freshness. With
`domain = "beacon-semiprime personal v2"` (ASCII, no terminator):

```
seed = SHA-256( domain ‖ randomness (32 bytes) ‖ UTF-8( NFC(passphrase) ) )
p, q, N  as in §3, with `seed` in place of the randomness
```

The passphrase is Unicode-normalized to NFC and otherwise used as given: not trimmed, not
case-folded. Sizes, tags, the word bound and the gap rule are unchanged. Implementations MUST
NOT transmit or store the passphrase or the personal number; the archive (§6) holds public
numbers only, so a personal number is re-derived from its round and passphrase.

## 8. Test vectors

See `test-vectors.json`: three real rounds, derived at every size in its `sizes` list, and
also as personal numbers with its `passphrase` (which contains a decomposed `é`, so that NFC
normalization is exercised). Expected public results at the tiers (`python3 verify.py
--vectors` prints every size):

| round      | D  | p          | q          | N                | N words                               |
|------------|----|------------|------------|------------------|---------------------------------------|
| 1          | 5  | 211        | 127        | 26797            | accuse between                        |
| 1          | 7  | 2 027      | 1 277      | 2588479          | over tree                             |
| 1          | 10 | 47 317     | 82 963     | 3925560271       | insane unfold ketchup                 |
| 1          | 16 | 65 133 637 | 87 416 143 | 5693731326102091 | chronic pluck mountain mixed enact    |
| 20 000 000 | 5  | 163        | 293        | 47759            | actual faint                          |
| 20 000 000 | 7  | 1 423      | 1 993      | 2836039          | public similar                        |
| 20 000 000 | 10 | 50 989     | 73 433     | 3744275237       | hurdle refuse gorilla                 |
| 20 000 000 | 16 | 90 958 121 | 45 780 571 | 4164114716467091 | budget record scorpion tuna venue     |
| 33 470 004 | 5  | 157        | 293        | 46001            | actress involve                       |
| 33 470 004 | 7  | 1 511      | 1 009      | 1524599          | fringe humble                         |
| 33 470 004 | 10 | 73 037     | 32 441     | 2369393317       | educate tribe feed                    |
| 33 470 004 | 16 | 60 465 767 | 36 170 291 | 2187064387928197 | auto faint social ship awful          |

Factor words (`D = 10`): 47317 = `actual boy`, 82963 = `agree list`, 50989 = `adapt toss`,
73433 = `afford swamp`, 73037 = `afford predict`, 32441 = `acid strong`. At `D = 7` a factor is
one word: 1511 = `rude`, 1009 = `lawsuit`; at `D = 5`: 157 = `beauty`, 293 = `caution`.

Personal results for the vector passphrase (`personal_*` fields of `verify.py --vectors`), at the tiers:

| round      | D  | p          | q          | N                | N words                                |
|------------|----|------------|------------|------------------|----------------------------------------|
| 1          | 5  | 193        | 307        | 59251            | adjust unveil                          |
| 1          | 7  | 1 553      | 1 009      | 1566977          | garden cage                            |
| 1          | 10 | 93 601     | 64 553     | 6042225353       | reduce neither float                   |
| 1          | 16 | 64 166 657 | 44 155 159 | 2833288942333463 | before assist dinosaur spawn seed      |
| 20 000 000 | 5  | 311        | 157        | 48827            | actual student                         |
| 20 000 000 | 7  | 1 511      | 1 019      | 1539709          | fuel soul                              |
| 20 000 000 | 10 | 41 903     | 99 643     | 4175340629       | ladder kind melt                       |
| 20 000 000 | 16 | 85 581 887 | 37 306 307 | 3192744150061309 | birth lady filter rally cabbage        |
| 33 470 004 | 5  | 227        | 137        | 31099            | acid control                           |
| 33 470 004 | 7  | 1 399      | 2 011      | 2813389          | produce rifle                          |
| 33 470 004 | 10 | 47 533     | 90 107     | 4283056031       | leisure cigar view                     |
| 33 470 004 | 16 | 39 668 579 | 87 514 949 | 3471593668087471 | board film random mother sting         |
