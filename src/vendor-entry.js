// Entry for the vendored crypto bundle. Built with: npm run build:vendor
// Exposes exactly what index.html needs: SHA-256 and BLS12-381 short-signature verification.
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

// verifyRound(signatureHex, messageBytes, publicKeyHex, DST) -> boolean (never throws)
function verifyRound(signatureHex, messageBytes, publicKeyHex, DST) {
  try {
    const bls = bls12_381.shortSignatures;
    const P = bls.hash(messageBytes, DST);
    return bls.verify(hexToBytes(signatureHex), P, hexToBytes(publicKeyHex)) === true;
  } catch (e) {
    return false;
  }
}

globalThis.__noble = { sha256, verifyRound, hexToBytes, bytesToHex,
  versions: { '@noble/curves': '2.4.0', '@noble/hashes': '2.4.0' } };
