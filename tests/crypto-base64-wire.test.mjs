// Runtime round-trip regression tests for the RSA-key base64 P2P wire helpers in
// src/utils/crypto.ts (arrayBufferToBase64 / base64ToArrayBuffer /
// exportRsaPublicKeyToBase64 / importRsaPublicKeyFromBase64).
//
// These helpers carry the peer's RSA public key over the wire as base64 in two
// places: the offer link's `p` URL param (OfferPage.svelte createSDPLink) and
// the answer code's `|key` portion (ReceivePage.svelte generateAnswerSDP). The
// existing tests only statically regex-matched that the call sites exist, so a
// base64 fidelity/charset bug would silently break every encrypted transfer at
// the first handshake step. These tests exercise the real encode/decode paths.
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Mirror tests/crypto.test.mjs: Node strips the TS annotations in crypto.ts
// natively (erasable TS syntax), and WebCrypto (btoa/atob/crypto.subtle) is
// available in this harness.
const here = dirname(fileURLToPath(import.meta.url));
const {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  generateRsaKeyPair,
  exportRsaPublicKeyToBase64,
  importRsaPublicKeyFromBase64,
  generateAesKey,
  encryptAesKeyWithRsaPublicKey,
  decryptAesKeyWithRsaPrivateKey
} = await import(join(here, '..', 'src', 'utils', 'crypto.ts'));

const assertBufferEqual = (actual, expected, label) => {
  const a = new Uint8Array(actual);
  const b = new Uint8Array(expected);
  assert.equal(
    a.length,
    b.length,
    `${label}: round-trip length ${a.length} !== original ${b.length}`
  );
  assert.deepEqual(Array.from(a), Array.from(b), `${label}: round-trip bytes differ`);
};

// 1. base64ToArrayBuffer(arrayBufferToBase64(x)) is byte-identical to x,
// covering every base64 remainder case (length % 3 in {0, 1, 2}) plus
// representative small and larger random buffers.
const cases = [
  { label: 'empty', bytes: new Uint8Array(0) },
  { label: '1 byte (remainder 1)', bytes: new Uint8Array([0x42]) },
  { label: '2 bytes (remainder 2)', bytes: new Uint8Array([0x00, 0xff]) },
  { label: '3 bytes (remainder 0)', bytes: new Uint8Array([0x00, 0x01, 0x80]) },
  { label: 'edge byte values', bytes: new Uint8Array([0x00, 0xff, 0x2f, 0x2b]) },
  { label: 'random 342 bytes', bytes: new Uint8Array(randomBytes(342)) },
  { label: 'random 1024 bytes', bytes: new Uint8Array(randomBytes(1024)) }
];
for (const { label, bytes } of cases) {
  const roundTripped = base64ToArrayBuffer(arrayBufferToBase64(bytes.buffer));
  assertBufferEqual(roundTripped, bytes.buffer, `round-trip ${label}`);
  // 2. Output matches the platform reference exactly, pinning the base64
  // charset (+, /, = padding) the peer must match — not just self-consistency.
  assert.equal(
    arrayBufferToBase64(bytes.buffer),
    Buffer.from(bytes).toString('base64'),
    `base64 of ${label} differs from platform reference`
  );
}

// 3. Full wire round-trip of the RSA public key: export -> base64 -> import ->
// re-export. The second base64 must equal the first (stable key encoding), the
// imported key's JWK n/e must match the original, and the imported key must be
// usable for the actual handshake operation (encrypt with imported public key,
// decrypt with the private key -> original AES key recovered).
const keyPair = await generateRsaKeyPair();
const firstBase64 = await exportRsaPublicKeyToBase64(keyPair.publicKey);
assert.match(
  firstBase64,
  /^[A-Za-z0-9+/]+={0,2}$/,
  'exported key must be canonical base64 (padding only at the end)'
);

const importedKey = await importRsaPublicKeyFromBase64(firstBase64);
const secondBase64 = await exportRsaPublicKeyToBase64(importedKey);
assert.equal(secondBase64, firstBase64, 're-exported key base64 must equal the original');

const originalJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
const importedJwk = await crypto.subtle.exportKey('jwk', importedKey);
assert.equal(importedJwk.n, originalJwk.n, 'imported key modulus must match the original');
assert.equal(importedJwk.e, originalJwk.e, 'imported key exponent must match the original');

const aesKey = await generateAesKey();
const rawAes = await crypto.subtle.exportKey('raw', aesKey);
const encrypted = await encryptAesKeyWithRsaPublicKey(importedKey, aesKey);
const recovered = await decryptAesKeyWithRsaPrivateKey(keyPair.privateKey, encrypted);
assert.deepEqual(
  await crypto.subtle.exportKey('raw', recovered),
  rawAes,
  'AES key must survive encrypt-with-imported / decrypt-with-private'
);

// 4. Large buffers: 1,000,000 bytes round-trips without throwing (a single
// String.fromCharCode.apply(null, wholeArray) call overflows the JS stack for
// >~65k elements, so the helper must chunk the conversion) and matches the
// platform reference byte-for-byte.
const big = new Uint8Array(randomBytes(1_000_000));
let bigBase64;
assert.doesNotThrow(() => {
  bigBase64 = arrayBufferToBase64(big.buffer);
}, 'arrayBufferToBase64 must handle buffers larger than one apply() call stack');
assert.equal(bigBase64, Buffer.from(big).toString('base64'), 'large-buffer base64 reference');
assertBufferEqual(base64ToArrayBuffer(bigBase64), big.buffer, 'round-trip 1MB buffer');

console.log(
  'ok - base64 wire helpers round-trip byte-identically, pin the platform charset, and survive the RSA wire round-trip'
);
