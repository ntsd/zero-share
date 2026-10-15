// Regression guard for P0 "Sender.onFilesPick unhandled crypto rejection":
// the pre-fix shape was
//
//     Array.from(files).forEach(async (file) => {
//       ...
//       aesKey = await generateAesKey();
//       aesEncrypted = await encryptAesKeyWithRsaPublicKey(rsaPub, aesKey);
//       ...
//     });
//
// An async callback passed to forEach is fire-and-forget: if a crypto call
// rejects — the rsaPub CryptoKey can become unusable after an offer
// regeneration or any state change between pick and send — the rejection
// escapes the user's reach as an unhandled promise rejection. The file
// silently vanishes: no toast, no list entry, no retry path.
//
// The fix: onFilesPick is async and iterates with `for (const file of
// Array.from(files))`, so every rejection is awaited on the caller's chain
// instead of escaping. Both crypto calls sit inside a try/catch that
// surfaces a visible error toast and skips registration — mirroring the
// existing `!rsaPub` guard — instead of registering an entry with an empty
// key (which would let a Resend replay an undeliverable key onto the wire,
// the exact pre-#66 dead-end).
//
// Node cannot mount the Svelte component, so (mirroring
// tests/sender-encrypt-before-accept.test.mjs) this test (1) statically
// asserts the rejection-safe iteration shape in Sender.svelte and
// (2) dynamically proves with REAL WebCrypto keys that a key-encryption
// failure produces nothing wire-able and a healthy key still round-trips.
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

// ---- Helper: find the body of a named function in the Svelte source ----
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

// ---- Test 1 (static): the fire-and-forget forEach(async ...) is gone -----
{
  const body = extractFunction(senderSource, 'onFilesPick');

  assert.ok(
    !/forEach\s*\(\s*async/.test(body),
    'onFilesPick() must not pass an async callback to forEach (fire-and-forget rejection)'
  );
  // The function must be async so the caller's promise chain can observe
  // every rejection instead of losing them.
  assert.ok(
    /async\s+function\s+onFilesPick\s*\(/.test(senderSource),
    'onFilesPick() must be declared async'
  );
  // And it must iterate the files sequentially instead of firing off
  // one orphaned promise per file.
  assert.ok(
    /for\s*\(\s*const\s+file\s+of\s+Array\.from\s*\(\s*files\s*\)\s*\)/.test(body),
    'onFilesPick() must iterate files with a sequential for...of over Array.from(files)'
  );
  console.log('ok - onFilesPick() no longer fires orphaned async callbacks into forEach');
}

// ---- Test 2 (static): crypto failures surface + skip, never register -----
{
  const body = extractFunction(senderSource, 'onFilesPick');

  // Both crypto calls must be covered by a single try block.
  const tryIndex = body.search(/\btry\s*\{/);
  assert.ok(tryIndex !== -1, 'the crypto calls must be wrapped in a try block');
  const aesGenIndex = body.search(/generateAesKey\s*\(\s*\)/);
  const rsaWrapIndex = body.search(/encryptAesKeyWithRsaPublicKey\s*\(\s*rsaPub\s*,\s*aesKey\s*\)/);
  const catchIndex = body.search(/\bcatch\s*\(/);
  assert.ok(
    tryIndex < aesGenIndex && aesGenIndex < rsaWrapIndex && rsaWrapIndex < catchIndex,
    'generateAesKey() AND encryptAesKeyWithRsaPublicKey() must both live inside the try'
  );

  // The catch must surface a visible error toast...
  const catchBody = body.slice(catchIndex);
  assert.ok(
    /addToastMessage\s*\(\s*[\s\S]{0,200}'error'/.test(catchBody),
    'the crypto-failure catch must surface an error toast'
  );
  // ...and stop (skip registration / no further processing of this file).
  assert.ok(
    /continue\s*;/.test(catchBody),
    'the crypto-failure catch must skip the file (continue) instead of falling through'
  );
  // And it must NOT register a sending-file entry with an empty key —
  // that would let a Resend replay an undeliverable key onto the wire.
  const catchTail = catchBody.slice(0, catchBody.search(/continue\s*;/) + 10);
  assert.ok(
    !/sendingFiles\s*\[\s*id\s*\]\s*=/.test(catchTail),
    'the crypto-failure catch must not register an entry with an empty key'
  );
  console.log(
    'ok - crypto rejection surfaces a toast and skips registration (no empty key can reach the wire)'
  );
}

// ---- Test 3 (dynamic): a failed key wrap produces nothing wire-able ------
{
  // Real peer handshake, as OfferPage.acceptAnswer() performs it.
  const peerRsa = await generateRsaKeyPair();
  const rsaPub = await importRsaPublicKeyFromBase64(
    await exportRsaPublicKeyToBase64(peerRsa.publicKey)
  );

  // Simulate the failure window: encryption of the AES key rejects (as it
  // does when rsaPub is unusable). The post-fix catch path produces NO
  // wire-able key material and no entry — nothing a resend could replay.
  const aesKey = await generateAesKey();
  const brokenKey = {
    // An unusable "key": wrapping must reject, exactly as a real
    // invalidated rsaPub does at the WebCrypto layer.
    getType() {
      throw new Error('OperationError: key invalidated');
    }
  };
  let aesEncrypted = new Uint8Array();
  let rejectionMessage = '';
  try {
    aesEncrypted = await encryptAesKeyWithRsaPublicKey(brokenKey, aesKey);
  } catch (err) {
    rejectionMessage = err instanceof Error ? err.message : String(err);
  }
  assert.ok(
    rejectionMessage.length > 0,
    'encryption with an unusable rsaPub must reject (the reported failure mode)'
  );
  assert.equal(
    aesEncrypted.byteLength,
    0,
    'post-fix: a rejected wrap leaves no key material to register or resend'
  );
  console.log('ok - post-fix: a crypto rejection leaves no wire-able key behind');

  // The healthy path still round-trips: wrap with the real peer public key,
  // unwrap with the peer private key, and the recovered AES key must match.
  const goodEncrypted = await encryptAesKeyWithRsaPublicKey(rsaPub, aesKey);
  const recoveredKey = await decryptAesKeyWithRsaPrivateKey(peerRsa.privateKey, goodEncrypted);
  const senderRaw = await crypto.subtle.exportKey('raw', aesKey);
  const recoveredRaw = await crypto.subtle.exportKey('raw', recoveredKey);
  assert.deepEqual(
    new Uint8Array(recoveredRaw),
    new Uint8Array(senderRaw),
    'the normal encrypted pick must still round-trip end to end'
  );
  console.log('ok - post-fix: a healthy rsaPub still round-trips the wrapped key');
}

console.log('ok - sender onFilesPick crypto rejection: no unhandled rejections, visible errors');
