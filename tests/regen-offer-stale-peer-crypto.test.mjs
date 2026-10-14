// Regression guard for P0 "regenerating the offer link leaves the sender's
// settled peer crypto state stale — new generation encrypts with the previous
// peer's RSA key / previous encryption mode":
//   1. generateOfferLink() re-minted the sender's OWN keypair (`rsa`) on every
//      regeneration and tore down the old peer/channel/timer, but never reset
//      the session's settled PEER state. `rsaPub` (the previous peer's public
//      key, imported by acceptAnswer) stayed present, so Sender.onFilesPick's
//      `if (!rsaPub)` guard PASSED for a pick made before the new answer was
//      accepted and wrapped the AES key for the DEAD peer — the new peer
//      (whose keypair was re-minted in its own generateAnswerSDP) could not
//      decrypt it: "Failed to decrypt the file key", transfer dead-ends.
//      This is the mirror of #66 but the stale key is PRESENT, not undefined,
//      so #66's guard does not catch it.
//   2. effectiveEncrypt stayed pinned to the previous session's mode (the
//      onOptionsUpdate re-sync is gated on !offerLink, and during a
//      regeneration the old link is still set). A plaintext<->encrypted flip
//      across regenerations then mismatched the new link's `p` key: encrypted
//      chunks hit a plaintext receiver (or vice versa) and every chunk failed
//      GCM auth -> "corrupt chunk (decryption error)".
//   3. UI state of the dead generation also rode along: showNewFile kept the
//      "New files" badge bouncing on the Receive tab, isConnecting (set by the
//      old channel's onopen, detached before close so onclose can't clear it)
//      kept "2. Accept Answer" collapsed and misreported the new channel as
//      connected, and a lingering answer code let a stale Accept click run
//      setRemoteDescription against the NEW peer ("Invalid answer code").
//
// The fix: at the top of generateOfferLink(), in the existing teardown block
// and BEFORE the new keypair is minted / the new peer is created:
//   rsaPub = undefined
//   effectiveEncrypt = sendOptions.isEncrypt
//   showNewFile = false
//   isConnecting = false
//   answerSDP = ''
//
// RTCPeerConnection is browser-only and cannot be exercised under Node, so
// this test (like tests/offer-peer-lifecycle.test.mjs and
// tests/sender-encrypt-before-accept.test.mjs) combines a static assertion of
// the wiring in OfferPage.svelte with a dynamic drive of the
// Sender.onFilesPick #66 guard against REAL WebCrypto keys (Node strips the
// type annotations in src/utils/crypto.ts natively): a pick under the stale
// (dead-peer) rsaPub must be rejected by the guard, while a pick under a
// fresh, answer-accepted peer key still wraps normally and round-trips
// through the receiver-side decryption.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ---- Helper: find the body of a named function in Svelte source ----
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

const offerSource = readFileSync(join(here, '..', 'src', 'components', 'OfferPage.svelte'), 'utf8');
const genBody = extractFunction(offerSource, 'generateOfferLink');

// Anchors for "before the new generation": the keypair re-mint and the new
// peer creation are where the new generation's crypto state begins.
const mintIdx = genBody.search(/generateRsaKeyPair\s*\(/);
assert.ok(mintIdx !== -1, 'generateOfferLink must still mint the RSA keypair');
const peerIdx = genBody.search(/await\s+createPeerAndDataCannel\s*\(/);
assert.ok(peerIdx !== -1, 'generateOfferLink must still create the peer and data channel');

// The teardown block that owns the resets: closing the previous peer.
const teardownIdx = genBody.search(/connection\.close\(\)/);
assert.ok(teardownIdx !== -1, 'generateOfferLink must close the previous RTCPeerConnection');

// ---- Test 1 (static): the settled peer crypto is reset in the teardown ----
// rsaPub = undefined makes Sender.onFilesPick's #66 guard reject a pick made
// before the new answer is accepted, instead of wrapping the AES key for the
// dead peer's public key.
{
  const rsaPubIdx = genBody.search(/rsaPub\s*=\s*undefined/);
  assert.ok(rsaPubIdx !== -1, 'generateOfferLink must reset rsaPub = undefined on regeneration');
  assert.ok(
    rsaPubIdx > teardownIdx && rsaPubIdx < mintIdx,
    'rsaPub must be reset in the teardown block, BEFORE the new keypair is minted'
  );
  console.log(
    'ok - generateOfferLink resets the previous peer rsaPub before minting the new keypair'
  );
}

// ---- Test 2 (static): the settled mode is re-pinned to the current setting -
// effectiveEncrypt = sendOptions.isEncrypt pins the new session to the current
// setting; the new link's `p` param and the new acceptAnswer() then re-pin it
// exactly as in the first-time flow.
{
  const effIdx = genBody.search(/effectiveEncrypt\s*=\s*sendOptions\.isEncrypt/);
  assert.ok(
    effIdx !== -1,
    'generateOfferLink must reset effectiveEncrypt = sendOptions.isEncrypt on regeneration'
  );
  assert.ok(
    effIdx > teardownIdx && effIdx < mintIdx,
    'effectiveEncrypt must be re-pinned in the teardown block, BEFORE the new keypair is minted'
  );
  console.log(
    'ok - generateOfferLink re-pins effectiveEncrypt to the current setting on regeneration'
  );
}

// ---- Test 3 (static): dead-generation UI state is cleared in the teardown --
{
  const showNewFileIdx = genBody.search(/showNewFile\s*=\s*false/);
  assert.ok(
    showNewFileIdx !== -1 && showNewFileIdx > teardownIdx && showNewFileIdx < mintIdx,
    'generateOfferLink must reset showNewFile = false in the teardown block'
  );
  const isConnectingIdx = genBody.search(/isConnecting\s*=\s*false/);
  assert.ok(
    isConnectingIdx !== -1 && isConnectingIdx > teardownIdx && isConnectingIdx < mintIdx,
    'generateOfferLink must reset isConnecting = false in the teardown block'
  );
  const answerSDPIidx = genBody.search(/answerSDP\s*=\s*['"]{2}/);
  assert.ok(
    answerSDPIidx !== -1 && answerSDPIidx > teardownIdx && answerSDPIidx < mintIdx,
    'generateOfferLink must reset answerSDP to the empty string in the teardown block'
  );
  console.log(
    'ok - the dead generation showNewFile/isConnecting/answerSDP are cleared in the teardown'
  );
}

// ---- Test 4 (dynamic): the #66 guard drives the regeneration window --------
// The post-regeneration, pre-answer window: rsaPub is undefined (reset by the
// fix). The guard must reject the pick — no key material for the dead peer.
const {
  generateRsaKeyPair,
  exportRsaPublicKeyToBase64,
  importRsaPublicKeyFromBase64,
  generateAesKey,
  encryptAesKeyWithRsaPublicKey,
  decryptAesKeyWithRsaPrivateKey
} = await import(join(here, '..', 'src', 'utils', 'crypto.ts'));

// Mirrors Sender.onFilesPick's decision: isEncrypt gates the block, the
// !rsaPub guard rejects (toast + early return) before any key generation.
async function onFilesPickDecision(isEncrypt, rsaPub) {
  let aesKey;
  let aesEncrypted = new Uint8Array();
  if (isEncrypt) {
    if (!rsaPub) {
      return { rejected: true, aesKey, aesEncrypted };
    }
    aesKey = await generateAesKey();
    aesEncrypted = await encryptAesKeyWithRsaPublicKey(rsaPub, aesKey);
  }
  return { rejected: false, aesKey, aesEncrypted };
}

{
  const isEncrypt = true;
  const rsaPubUndefined = undefined;
  const { rejected, aesKey, aesEncrypted } = await onFilesPickDecision(isEncrypt, rsaPubUndefined);
  assert.equal(rejected, true, 'post-regeneration (rsaPub undefined) pick must be rejected');
  assert.equal(aesKey, undefined, 'no AES key is generated for a rejected pick');
  assert.equal(aesEncrypted.byteLength, 0, 'nothing wire-able is produced');
  console.log('ok - post-regeneration window: the #66 guard rejects the pick (rsaPub undefined)');
}

// ---- Test 5 (dynamic): the pre-fix stale key dead-ends at the receiver -----
// Pre-fix shape: rsaPub still held the DEAD peer's key (never reset). The
// guard PASSES, the AES key is wrapped for the dead peer, and the NEW peer's
// freshly-minted private key cannot unwrap it — exactly the reported failure.
{
  const deadPeer = await generateRsaKeyPair();
  const staleRsaPub = await importRsaPublicKeyFromBase64(
    await exportRsaPublicKeyToBase64(deadPeer.publicKey)
  );
  const newPeer = await generateRsaKeyPair();

  const { rejected, aesKey, aesEncrypted } = await onFilesPickDecision(true, staleRsaPub);
  assert.equal(rejected, false, 'pre-fix: the stale rsaPub passed the !rsaPub guard');
  assert.ok(aesKey, 'pre-fix: an AES key was generated');
  assert.ok(aesEncrypted.byteLength > 0, 'pre-fix: the key was wrapped for the dead peer');
  await assert.rejects(
    decryptAesKeyWithRsaPrivateKey(newPeer.privateKey, aesEncrypted),
    'pre-fix: the new peer cannot decrypt a key wrapped for the dead peer (the reported dead-end)'
  );
  console.log('ok - pre-fix control: a pick under the stale rsaPub dead-ends at the new peer');
}

// ---- Test 6 (dynamic): the post-regeneration normal flow still round-trips -
// After the new answer is accepted, acceptAnswer() re-imports the new peer's
// key; a pick then wraps normally and the new peer unwraps it byte-for-byte.
{
  const newPeer = await generateRsaKeyPair();
  const freshRsaPub = await importRsaPublicKeyFromBase64(
    await exportRsaPublicKeyToBase64(newPeer.publicKey)
  );
  const { rejected, aesKey, aesEncrypted } = await onFilesPickDecision(true, freshRsaPub);
  assert.equal(
    rejected,
    false,
    'a pick under a fresh, answer-accepted peer key must not be rejected'
  );
  assert.ok(aesKey, 'the AES key is generated for the new peer');
  assert.ok(aesEncrypted.byteLength > 0, 'the key is wrapped for the new peer');

  const recoveredKey = await decryptAesKeyWithRsaPrivateKey(newPeer.privateKey, aesEncrypted);
  const senderRaw = await crypto.subtle.exportKey('raw', aesKey);
  const recoveredRaw = await crypto.subtle.exportKey('raw', recoveredKey);
  assert.deepEqual(
    new Uint8Array(recoveredRaw),
    new Uint8Array(senderRaw),
    'the new peer must recover the sender exact AES key'
  );
  console.log(
    'ok - post-regeneration: pick after the new answer acceptance round-trips end to end'
  );
}

// ---- Test 7 (static): Sender's #66 guard shape is intact --------------------
{
  const senderSource = readFileSync(
    join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
    'utf8'
  );
  const body = extractFunction(senderSource, 'onFilesPick');
  assert.ok(
    /if\s*\(\s*!rsaPub\s*\)/.test(body),
    'onFilesPick() must keep the `if (!rsaPub)` guard that rejects a missing/stale rsaPub'
  );
  assert.ok(
    /encryptAesKeyWithRsaPublicKey\(\s*rsaPub\s*,\s*aesKey\s*\)/.test(body),
    'onFilesPick() must still wrap the AES key with the peer rsaPub on the normal path'
  );
  console.log('ok - Sender.onFilesPick keeps the #66 guard that the regeneration reset feeds');
}

console.log(
  'ok - regeneration resets the settled peer crypto: no stale rsaPub, no stale mode, clean UI state'
);
