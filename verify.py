#!/usr/bin/env python3
"""Independent verifier for beacon-semiprime (SPEC.md v2).

Usage:
  python3 verify.py ROUND                 fetch round from drand, derive N, show factors
  python3 verify.py --json round.json     same, from a saved round JSON (offline)
  python3 verify.py --check ROUND F [G]   check one or two factors (decimal or words)
  python3 verify.py --vectors             print test vectors for rounds in test-vectors.json

  --digits D (before the other arguments) selects the size of N; default 10 (two 5-digit
  factors, 3 words; a factor is 2 words). 16 is also defined (8-digit factors, 5 and 3 words).

Derivation uses only the standard library. BLS signature verification is attempted if
`py_ecc` is installed (pip install py_ecc); otherwise it is reported as skipped. The
randomness == SHA-256(signature) check always runs.
"""
import hashlib, json, os, sys, urllib.request

CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
PUBLIC_KEY = ("83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a")
GENESIS, PERIOD = 1692803367, 3
DST = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_"
RELAYS = ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"]

# ---- sizes (SPEC.md §2): digits of N -> parameters ----
MIN_FERMAT = 1000                       # Fermat's method must need at least this many iterations

def isqrt(n):
    import math
    return math.isqrt(n)

def make_size(digits, words, factor_words):
    fd = digits // 2
    HIGH = 10**fd                                    # factors are strictly below this
    LOW = isqrt(10**(digits - 1) - 1) + 1            # ceil(sqrt(10^(digits-1))): p*q >= 10^(digits-1)
    RANGE = HIGH - LOW
    LIMIT = (2**32 // RANGE) * RANGE                 # rejection threshold for the 32-bit sample
    WORD_MAX = 1 << (11 * words)                     # N must fit in `words` words
    assert digits % 2 == 0 and fd <= 8 and WORD_MAX > 10**(digits - 1) and (1 << (11 * factor_words)) >= HIGH
    return dict(digits=digits, factor_digits=fd, words=words, factor_words=factor_words,
                LOW=LOW, HIGH=HIGH, RANGE=RANGE, LIMIT=LIMIT, WORD_MAX=WORD_MAX)

SIZES = {10: make_size(10, 3, 2), 16: make_size(16, 5, 3)}
DEFAULT_DIGITS = 10

HERE = os.path.dirname(os.path.abspath(__file__))
WORDS = json.load(open(os.path.join(HERE, "src", "wordlist.json")))
assert len(WORDS) == 2048
WORD_INDEX = {w: i for i, w in enumerate(WORDS)}

# ---- primality: trial division, exact below 10^8 ----
_sieve = bytearray([1]) * 10001
_sieve[0] = _sieve[1] = 0
for i in range(2, 101):
    if _sieve[i]:
        _sieve[i*i::i] = bytearray(len(_sieve[i*i::i]))
SMALL_PRIMES = [i for i in range(10001) if _sieve[i]]      # 1229 primes

def is_prime(n):
    if n < 2:
        return False
    for p in SMALL_PRIMES:
        if p * p > n:
            return True
        if n % p == 0:
            return n == p
    return True

def next_prime(n):
    while not is_prime(n):
        n += 1
    return n

# ---- derivation (SPEC.md §3) ----
def far_apart(p, q):
    """(p+q)/2 - sqrt(pq) >= MIN_FERMAT, exactly in integers (SPEC.md §3.3)."""
    s = p + q - 2 * MIN_FERMAT
    return s >= 0 and s * s >= 4 * p * q

def derive_prime(seed, tag, sz, accept=lambda f: True):
    for ctr in range(256):
        h = hashlib.sha256(seed + tag.encode() + bytes([ctr])).digest()
        x = int.from_bytes(h[:4], "big")
        if x >= sz["LIMIT"]:
            continue
        p = next_prime(sz["LOW"] + x % sz["RANGE"])
        if p >= sz["HIGH"] or not accept(p):
            continue
        return p
    raise RuntimeError("counter exhausted")

def derive_factors(randomness_hex, digits=DEFAULT_DIGITS):
    sz = SIZES[digits]
    seed = bytes.fromhex(randomness_hex)
    assert len(seed) == 32
    p = derive_prime(seed, "p%d" % digits, sz)
    q = derive_prime(seed, "q%d" % digits, sz, lambda f: f != p and p * f < sz["WORD_MAX"] and far_apart(p, f))
    return p, q

# ---- wordlist encoding (SPEC.md §4) ----
def encode_words(n, count):
    assert 0 <= n < 2**(11*count)
    return [WORDS[(n >> (11*i)) & 2047] for i in range(count-1, -1, -1)]

def word_index(w):
    w = w.lower()
    if w in WORD_INDEX:
        return WORD_INDEX[w]
    if len(w) >= 4:
        hits = [x for x in WORDS if x.startswith(w)]
        if len(hits) == 1:
            return WORD_INDEX[hits[0]]
    raise ValueError("unknown word: " + w)

def decode_words(ws):
    n = 0
    for w in ws:
        n = (n << 11) | word_index(w)
    return n

def parse_factor(tokens, sz):
    """tokens: ['12345'] or sz['factor_words'] words -> int"""
    if len(tokens) == 1 and tokens[0].isdigit():
        return int(tokens[0])
    if len(tokens) == sz["factor_words"]:
        return decode_words(tokens)
    raise ValueError("a factor is one decimal number or %d words" % sz["factor_words"])

# ---- beacon ----
def round_time(r):
    return GENESIS + (r - 1) * PERIOD

def fetch_round(r):
    last = None
    for relay in RELAYS:
        try:
            with urllib.request.urlopen(f"{relay}/{CHAIN_HASH}/public/{r}", timeout=10) as f:
                return json.load(f)
        except Exception as e:  # try next relay
            last = e
    raise SystemExit(f"could not fetch round {r}: {last}")

def verify_bls(beacon):
    """Returns True/False, or None if py_ecc is not installed."""
    try:
        from py_ecc.bls.hash_to_curve import hash_to_G1
        from py_ecc.bls.point_compression import decompress_G1, decompress_G2
        from py_ecc.optimized_bls12_381 import G2, neg, pairing, final_exponentiate, FQ12
    except ImportError:
        return None
    msg = hashlib.sha256(int(beacon["round"]).to_bytes(8, "big")).digest()
    H = hash_to_G1(msg, DST, hashlib.sha256)
    try:
        sig = decompress_G1(int.from_bytes(bytes.fromhex(beacon["signature"]), "big"))
        pk = decompress_G2((int.from_bytes(bytes.fromhex(PUBLIC_KEY[:96]), "big"),
                            int.from_bytes(bytes.fromhex(PUBLIC_KEY[96:]), "big")))
    except Exception:
        return False
    # e(sig, G2) == e(H, pk)  <=>  e(sig, G2) * e(H, -pk) == 1
    lhs = pairing(G2, sig, final_exponentiate=False)
    rhs = pairing(neg(pk), H, final_exponentiate=False)
    return final_exponentiate(lhs * rhs) == FQ12.one()

def report(beacon, digits=DEFAULT_DIGITS, show_factors=True):
    sz = SIZES[digits]
    r = int(beacon["round"])
    rnd, sig = beacon["randomness"].lower(), beacon["signature"].lower()
    rnd_ok = hashlib.sha256(bytes.fromhex(sig)).hexdigest() == rnd
    bls = verify_bls(beacon)
    p, q = derive_factors(rnd, digits)
    N = p * q
    import datetime
    t = datetime.datetime.fromtimestamp(round_time(r), datetime.timezone.utc)
    print(f"round        {r}")
    print(f"time (UTC)   {t.isoformat()}")
    print(f"randomness   {rnd}")
    print(f"rand==H(sig) {'OK' if rnd_ok else 'FAIL'}")
    print(f"BLS sig      {'skipped (pip install py_ecc)' if bls is None else ('OK' if bls else 'FAIL')}")
    print(f"N            {N}  ({digits} digits)")
    print(f"N words      {' '.join(encode_words(N, sz['words']))}")
    if show_factors:
        print(f"p            {p}  ({' '.join(encode_words(p, sz['factor_words']))})")
        print(f"q            {q}  ({' '.join(encode_words(q, sz['factor_words']))})")
    return N

def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__); return
    digits = DEFAULT_DIGITS
    if argv[0] == "--digits":
        digits = int(argv[1]); argv = argv[2:]
        if digits not in SIZES:
            raise SystemExit("supported sizes: " + ", ".join(map(str, SIZES)))
    sz = SIZES[digits]
    if argv[0] == "--vectors":
        vecs = json.load(open(os.path.join(HERE, "test-vectors.json")))
        for v in vecs["rounds"]:
            for d in vecs["sizes"]:
                z = SIZES[d]
                p, q = derive_factors(v["randomness"], d)
                print(json.dumps({"round": v["round"], "digits": d, "randomness": v["randomness"], "p": p, "q": q, "N": str(p*q),
                                  "N_words": encode_words(p*q, z["words"]), "p_words": encode_words(p, z["factor_words"]),
                                  "q_words": encode_words(q, z["factor_words"])}))
        return
    if argv[0] == "--json":
        beacon = json.load(open(argv[1]))
        report(beacon, digits); return
    if argv[0] == "--check":
        r = int(argv[1]); toks = argv[2:]
        beacon = fetch_round(r)
        N = report(beacon, digits, show_factors=False)
        # split tokens into factors: digit tokens stand alone, words in groups of factor_words
        factors, buf = [], []
        for t in toks:
            if t.isdigit():
                if buf: factors.append(parse_factor(buf, sz)); buf = []
                factors.append(int(t))
            else:
                buf.append(t)
                if len(buf) == sz["factor_words"]: factors.append(parse_factor(buf, sz)); buf = []
        if buf: raise SystemExit("word factors need exactly %d words each" % sz["factor_words"])
        if len(factors) == 1:
            f = factors[0]; ok = 1 < f < N and N % f == 0
            print(f"check        {f} {'divides N: CORRECT' if ok else 'does not divide N: WRONG'}")
        elif len(factors) == 2:
            ok = factors[0] * factors[1] == N and min(factors) > 1
            print(f"check        {factors[0]} x {factors[1]} {'= N: CORRECT' if ok else '!= N: WRONG'}")
        else:
            raise SystemExit("give one or two factors")
        return
    report(fetch_round(int(argv[0])), digits)

if __name__ == "__main__":
    main(sys.argv[1:])
