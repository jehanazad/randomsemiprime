// Prints derivation results for test-vectors.json using src/core.js, one JSON line per round and size.
import { sha256 } from '@noble/hashes/sha2.js';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
globalThis.__noble = { sha256 };
globalThis.BIP39_WORDS = JSON.parse(fs.readFileSync(path.join(here, '../src/wordlist.json'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(here, '../src/core.js'), 'utf8'));
const SP = globalThis.SP;

const vecs = JSON.parse(fs.readFileSync(path.join(here, '../test-vectors.json'), 'utf8'));
for (const v of vecs.rounds) {
  for (const digits of vecs.sizes) {
    const { p, q } = SP.deriveFactors(v.randomness, digits);
    const N = p * q;
    console.log(JSON.stringify({ round: v.round, digits, randomness: v.randomness, p: Number(p), q: Number(q), N: N.toString(),
      N_words: SP.encodeN(N, digits), p_words: SP.encodeFactor(p, digits), q_words: SP.encodeFactor(q, digits) }));
  }
}
