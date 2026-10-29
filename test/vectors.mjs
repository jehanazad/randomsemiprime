// Prints derivation results for test-vectors.json using src/core.js, one JSON line per round.
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
  const { p, q } = SP.deriveFactors(v.randomness);
  const N = p * q;
  console.log(JSON.stringify({ round: v.round, randomness: v.randomness, p: Number(p), q: Number(q), N: Number(N),
    N_words: SP.encodeN(N), p_words: SP.encodeFactor(p), q_words: SP.encodeFactor(q) }));
}
