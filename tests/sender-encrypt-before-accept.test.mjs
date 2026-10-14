// Regression guard for the P0 "file picked before the peer answer is accepted
// (encryption on, no rsaPub yet) is registered with an empty AES key and
// dead-ends the encrypted transfer at the receiver" bug.
//
// On the Offer page the Sender (and its drag-and-drop zone) is mounted as soon
// as the data channel exists — which happens at OFFER generation, BEFORE
// acceptAnswer() imports the peer's RSA public key into OfferPage.rsaPub.
// During that window the old Sender.svelte onFilesPick() guarded key
// generation with `if (isEncrypt && rsaPub)`: with rsaPub still undefined the
// guard was silently skipped, so the file was registered with
// `metaData.key = new Uint8Array()` (EMPTY). The receiver, in encrypted mode,
// then called decryptAesKeyWithRsaPrivateKey(rsa.privateKey, <empty>) →
// WebCrypto reject → "Failed to decrypt the file key" and the whole encrypted
// transfer dead-ended.
//
// The fix: in onFilesPick(), when isEncrypt is true but rsaPub is undefined,
// do NOT register the file — surface a visible error toast and skip it, so an
// empty key can never reach the wire.
//
// The Svelte component is not importable in plain Node, so (mirroring the
// static+dynamic style of tests/toast-id-unique.test.mjs and
// tests/sender-chunk-size.test.mjs) this test (1) statically asserts the
// guard exists in Sender.svelte and the old silent-skip is gone, and (2)
// dynamically drives the decision with REAL WebCrypto keys (Node strips the
// type annotations in src/utils/crypto.ts natively) to prove the rejected
// pick never produces a wire-able key and the normal post-accept flow round-
// trips through the real receiver-side decryption.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const senderSource = readFileSync(
  join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
  'utf8'
);

// Real crypto from the module under test — no copies that can drift.
const {
  generateRsaKeyPair,
  exportRsaPublicKeyToBase64,
  importRsaPublicKeyFromBase64,
  generateAesKey,
  encryptAesKeyWithRsaPublicKey,
  decryptAesKeyWithRsaPrivateKey
} = await import(join(here, '..', 'src', 'utils', 'crypto.ts'));

// ---- Helper: find the body of onFilesPick() in the Svelte source ----
function extractFunction(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.ok(start !== -1, `${name}() must exist`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new assert.AssertionError({ message: `${name}(): unbalanced braces` });
}

// ---- Test 1 (static): the rsaPub precondition guard rejects the pick -------
{
  const body = extractFunction(senderSource, 'onFilesPick');

  // The old defect: a single compound guard that silently skips key
  // generation (and registers an empty key) when rsaPub is undefined.
  assert.ok(
    !/if\s*\(\s*isEncrypt\s*&&\s*rsaPub\s*\)/.test(body),
    'onFilesPick() must not silently skip key generation when rsaPub is ' +
      'undefined (the pre-fix `if (isEncrypt && rsaPub)` registered an empty key)'
  );

  // The post-fix shape: with isEncrypt on, a missing rsaPub must surface a
  // visible error and bail out BEFORE any key generation or registration.
  assert.ok(
    /if\s*\(\s*!rsaPub\s*\)/.test(body),
    'onFilesPick() must explicitly guard a missing rsaPub when encryption is on'
  );
  const guardIndex = body.search(/if\s*\(\s*!rsaPub\s*\)/);
  const toastIndex = body.search(/addToastMessage\s*\(/);
  assert.ok(guardIndex !== -1 && toastIndex !== -1, 'the guard must surface a toast');
  assert.ok(
    toastIndex > guardIndex,
    'the toast must be emitted by the !rsaPub guard, not by a later code path'
  );
  const returnIndex = body.indexOf('return;', guardIndex);
  const cryptoIndex = body.search(/generateAesKey\s*\(\s*\)/);
  assert.ok(
    returnIndex !== -1 && returnIndex < cryptoIndex,
    'the guard must early-return BEFORE any AES key generation (no registration)'
  );
  assert.ok(
    /'error'/.test(body.slice(guardIndex, returnIndex)),
    'the missing-rsaPub rejection must be a visible error toast'
  );
  console.log(
    'ok - onFilesPick() rejects an encrypted pick before rsaPub exists (visible error, no registration)'
  );
}

// ---- Test 2 (dynamic): the pre-fix shape demonstrably dead-ends the -------
// ---- receiver, and the post-fix decision never emits an empty key ---------
{
  // The real peer handshake, as OfferPage.acceptAnswer() performs it:
  // generate the peer's keypair, ship the public key in the answer code,
  // import it on the sender side.
  const peerRsa = await generateRsaKeyPair();
  const peerPubBase64 = await exportRsaPublicKeyToBase64(peerRsa.publicKey);
  const rsaPub = await importRsaPublicKeyFromBase64(peerPubBase64);

  const file = { name: 'secret.bin', size: 1024, type: 'application/octet-stream' };

  // Pre-fix decision: `if (isEncrypt && rsaPub)` with rsaPub still undefined —
  // the window where the offer is live but the answer was never accepted.
  const isEncrypt = true;
  const rsaPubUndefined = undefined;
  let aesKey;
  let aesEncrypted = new Uint8Array();
  if (isEncrypt && rsaPubUndefined) {
    aesKey = await generateAesKey();
    aesEncrypted = await encryptAesKeyWithRsaPublicKey(rsaPub, aesKey);
  }
  const preFixMetaData = { name: file.name, size: file.size, type: file.type, key: aesEncrypted };
  assert.equal(
    preFixMetaData.key.byteLength,
    0,
    'pre-fix: pick before acceptAnswer produced an EMPTY metadata key'
  );
  // Prove the receiver-side consequence: decrypting that empty key with the
  // real peer private key rejects exactly like it did in the repro.
  await assert.rejects(
    decryptAesKeyWithRsaPrivateKey(peerRsa.privateKey, preFixMetaData.key),
    'pre-fix empty key must fail at the receiver (the reported dead-end)'
  );
  assert.ok(!aesKey, 'pre-fix: no AES key was ever generated for the file');
  console.log('ok - pre-fix control: empty-key metadata rejects at the receiver (bug reproduced)');

  // Post-fix decision, same window: isEncrypt true, rsaPub undefined → the
  // pick is rejected up front; no key material is generated at all.
  let rejected = false;
  let postFixAesKey;
  let postFixEncrypted = new Uint8Array();
  if (isEncrypt) {
    if (!rsaPubUndefined) {
      rejected = true; // visible error toast; file never registered
    } else {
      postFixAesKey = await generateAesKey();
      postFixEncrypted = await encryptAesKeyWithRsaPublicKey(rsaPub, postFixAesKey);
    }
  }
  assert.equal(rejected, true, 'post-fix: the pick is rejected when rsaPub is undefined');
  assert.equal(postFixAesKey, undefined, 'post-fix: no AES key is generated for a rejected pick');
  assert.equal(postFixEncrypted.byteLength, 0, 'post-fix: nothing wire-able is produced');
  console.log(
    'ok - post-fix: encrypt on + no rsaPub yet rejects the pick without generating a key'
  );
}

// ---- Test 3 (dynamic): the normal encrypted flow (pick after accept) ------
// ---- still works end to end -----------------------------------------------
{
  // Peer handshake settled: rsaPub is now imported (as acceptAnswer does).
  const peerRsa = await generateRsaKeyPair();
  const rsaPub = await importRsaPublicKeyFromBase64(
    await exportRsaPublicKeyToBase64(peerRsa.publicKey)
  );

  // Post-fix decision with the precondition satisfied: generate + wrap.
  const isEncrypt = true;
  let aesKey;
  let aesEncrypted = new Uint8Array();
  if (isEncrypt) {
    if (!rsaPub) {
      // rejected path — must NOT run here
      throw new Error('post-fix guard must not reject once rsaPub is available');
    }
    aesKey = await generateAesKey();
    aesEncrypted = await encryptAesKeyWithRsaPublicKey(rsaPub, aesKey);
  }

  const metaData = {
    name: 'secret.bin',
    size: 1024,
    type: 'application/octet-stream',
    key: aesEncrypted
  };
  assert.ok(
    metaData.key.byteLength > 0,
    'post-fix: registered metadata carries a real wrapped key'
  );

  // The receiver side of the real flow: unwrap with the peer private key and
  // the recovered AES key must match the sender's key byte-for-byte.
  const recoveredKey = await decryptAesKeyWithRsaPrivateKey(peerRsa.privateKey, metaData.key);
  const senderRaw = await crypto.subtle.exportKey('raw', aesKey);
  const recoveredRaw = await crypto.subtle.exportKey('raw', recoveredKey);
  assert.deepEqual(
    new Uint8Array(recoveredRaw),
    new Uint8Array(senderRaw),
    "post-fix: the receiver must recover the sender's exact AES key"
  );
  console.log('ok - post-fix: pick after answer acceptance still round-trips end to end');
}

// ---- Test 4 (static): the sender still hands the wrapped key to the wire --
{
  const body = extractFunction(senderSource, 'onFilesPick');
  // The registered metadata must still carry the wrapped key, and the entry
  // must still hold the local AES key used to encrypt the chunks.
  assert.ok(
    /key:\s*aesEncrypted/.test(body),
    'onFilesPick() must register metaData.key from the wrapped aesEncrypted key'
  );
  assert.ok(
    /encryptAesKeyWithRsaPublicKey\(\s*rsaPub\s*,\s*aesKey\s*\)/.test(body),
    'onFilesPick() must wrap the AES key with the peer rsaPub'
  );
  assert.ok(
    /aesKey:\s*aesKey/.test(body),
    'onFilesPick() must keep the local aesKey on the sending-file entry'
  );
  // The plaintext path (isEncrypt false) is unchanged: empty key is only
  // ever correct when the session itself is plaintext.
  assert.ok(
    /let aesEncrypted = new Uint8Array\(\);/.test(body),
    'the plaintext default (empty key) must still exist for isEncrypt=false'
  );
  console.log('ok - onFilesPick() still registers the wrapped key on the normal encrypted path');
}

console.log('ok - sender encrypt-before-accept: empty-key picks never reach the wire');
