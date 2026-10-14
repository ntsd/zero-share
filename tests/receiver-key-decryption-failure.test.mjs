// Regression guard for P0 "receiver's metadata key-decryption failure never
// signals the sender":
//   - In an encrypted session, when the receiver cannot decrypt a file's AES
//     key (metaData.key — empty, damaged in transit, or from a stale/leaked
//     peer RSA key), onMetaData() marked the entry errored locally and showed
//     a toast, then returned WITHOUT sending anything back to the peer.
//   - The sender had already set the file to WaitingAccept; its only exits are
//     peer-driven receive events (ACCEPT / RECEIVED_CHUNK / VALIDATE_ERROR /
//     REJECT), so the file sat in "Waiting Accept" forever — no error, no
//     Resend button, only Remove.
//
// The fix: the key-decryption catch in Receiver.svelte#onMetaData mirrors the
// validateErr path directly below it — it still sets the local error + toast,
// and now ALSO sends EVENT_VALIDATE_ERROR back over the data channel so the
// sender's handler bounces the file to Pending with an error and re-enables
// the Resend button. No sender-side accept timeout is introduced (per the
// human's direction on closed PR #41: "There should be no wait accept
// timeout" — the sender recovers from an explicit peer signal only).
//
// This test drives the onMetaData state machine with REAL WebCrypto RSA-OAEP
// decryption (so the key genuinely fails authentication) and encodes/decodes
// the outbound signal through the REAL generated Message proto, plus a static
// source-guard that the catch block in the component sends the signal before
// returning.
import { strict as assert } from 'node:assert';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');

// The receiver is a Svelte component (not importable in plain Node), so the
// fixture mirrors only the onMetaData() state machine; key decryption uses the
// REAL src/utils/crypto.ts so an empty/damaged key genuinely fails RSA-OAEP.
const {
  generateRsaKeyPair,
  generateAesKey,
  encryptAesKeyWithRsaPublicKey,
  decryptAesKeyWithRsaPrivateKey
} = await import(join(here, '..', 'src', 'utils', 'crypto.ts'));

// src/proto/message.ts contains a TS enum, which Node's strip-only loader
// cannot import directly (same reason as
// tests/message-decode-robustness.test.mjs) — transpile and load.
async function loadTranspiled(name, tmpSuffix) {
  const source = await readFile(join(here, '..', 'src', name), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020
    }
  });
  const tmpPath = join(here, `.receiver-key-decrypt.tmp-${tmpSuffix}.js`);
  await writeFile(tmpPath, compiled.outputText, 'utf8');
  try {
    return await import(tmpPath);
  } finally {
    await rm(tmpPath, { force: true });
  }
}
const { Message, ReceiveEvent } = await loadTranspiled('proto/message.ts', 'message');

// Faithful mirror of Receiver.svelte#onMetaData (post-fix): register the entry
// -> attempt RSA key decryption -> on failure: local error + toast + outbound
// EVENT_VALIDATE_ERROR + return (no accept, no chunk map). On success the
// metadata is usable; autoAccept sends EVENT_RECEIVER_ACCEPT.
function buildReceiver({ rsa, autoAccept = true }) {
  const isEncrypt = true;
  const state = { receivingFiles: {} };
  const sentFrames = []; // raw encoded Uint8Arrays, exactly as dataChannel.send would
  const toasts = [];
  const dataChannel = {
    send(frame) {
      sentFrames.push(frame);
    }
  };

  async function onMetaData(id, metaData) {
    state.receivingFiles[id] = {
      metaData,
      progress: 0,
      bitrate: 0,
      startTime: 0,
      status: 'WaitingAccept'
    };

    let aesKey;
    if (isEncrypt && rsa) {
      try {
        aesKey = await decryptAesKeyWithRsaPrivateKey(rsa.privateKey, metaData.key);
      } catch {
        // Key decryption failed: mark the entry so it can be seen and removed,
        // AND signal the sender (post-fix behavior under test).
        state.receivingFiles[id].error = new Error('Failed to decrypt the file key');
        toasts.push(`${metaData.name} failed to decrypt the file key`);
        dataChannel.send(
          Message.encode({
            id: id,
            receiveEvent: ReceiveEvent.EVENT_VALIDATE_ERROR
          }).finish()
        );
        return;
      }
    }
    state.receivingFiles[id].aesKey = aesKey;

    if (autoAccept) {
      // onAccept(): signal the peer and start processing.
      dataChannel.send(
        Message.encode({
          id: id,
          receiveEvent: ReceiveEvent.EVENT_RECEIVER_ACCEPT
        }).finish()
      );
      state.receivingFiles[id].status = 'Processing';
      state.receivingFiles[id].startTime = Date.now();
    }
  }

  function decodeAll() {
    return sentFrames.map((f) => Message.decode(f));
  }

  return { state, toasts, onMetaData, decodeAll, frameCount: () => sentFrames.length };
}

// ---- Test 1: empty key (the zf-zs-611c34f5 sender window) -> exactly one EVENT_VALIDATE_ERROR ----
{
  const rsa = await generateRsaKeyPair();
  const receiver = buildReceiver({ rsa });
  await receiver.onMetaData('file-1', {
    name: 'a.bin',
    size: 1024,
    type: 'application/octet-stream',
    key: new Uint8Array(0) // empty key: the RSA-OAEP decrypt genuinely throws
  });

  const file = receiver.state.receivingFiles['file-1'];
  assert.ok(file.error instanceof Error, 'the entry must carry the local decrypt error');
  assert.match(
    file.error.message,
    /decrypt/i,
    'the error must describe the key-decryption failure'
  );
  assert.equal(
    file.status,
    'WaitingAccept',
    'a failed key must NOT advance the entry to Processing (no accept may follow)'
  );
  assert.equal(file.aesKey, undefined, 'no AES key may be attached to a failed entry');

  // Exactly ONE outbound frame, and it must be a VALIDATE_ERROR for this id —
  // this is the signal that unblocks the sender's WaitingAccept state.
  assert.equal(
    receiver.frameCount(),
    1,
    'a key-decryption failure must produce exactly one outbound signal'
  );
  const decoded = receiver.decodeAll();
  assert.equal(
    decoded[0].receiveEvent,
    ReceiveEvent.EVENT_VALIDATE_ERROR,
    'the outbound signal must be EVENT_VALIDATE_ERROR (or REJECT) so the sender recovers'
  );
  assert.equal(decoded[0].id, 'file-1', 'the signal must target the failed file id');
  assert.ok(
    !decoded.some((m) => m.receiveEvent === ReceiveEvent.EVENT_RECEIVER_ACCEPT),
    'no accept may be sent for a file whose key failed to decrypt'
  );
  assert.ok(receiver.toasts.length === 1, 'the failure must still surface a local toast');
  console.log(
    'ok - empty key: entry errored, exactly one EVENT_VALIDATE_ERROR signaled back, no accept'
  );
}

// ---- Test 2: damaged key (garbage ciphertext) -> same single signal ----
{
  const rsa = await generateRsaKeyPair();
  const receiver = buildReceiver({ rsa });
  await receiver.onMetaData('file-2', {
    name: 'b.bin',
    size: 2048,
    type: 'application/octet-stream',
    // 256 random bytes: plausible length for an RSA-2048-OAEP ciphertext of a
    // 32-byte AES key, but not a valid ciphertext -> decrypt throws.
    key: crypto.getRandomValues(new Uint8Array(256))
  });

  const file = receiver.state.receivingFiles['file-2'];
  assert.ok(file.error instanceof Error, 'a damaged key must error the entry locally');
  assert.equal(receiver.frameCount(), 1, 'a damaged key must produce exactly one outbound signal');
  assert.equal(
    receiver.decodeAll()[0].receiveEvent,
    ReceiveEvent.EVENT_VALIDATE_ERROR,
    'a damaged key must signal EVENT_VALIDATE_ERROR back to the sender'
  );
  console.log('ok - damaged key: entry errored, exactly one EVENT_VALIDATE_ERROR signaled back');
}

// ---- Test 3: control — a valid key still accepts and sends NO validate error ----
{
  const rsa = await generateRsaKeyPair();
  const aesKey = await generateAesKey();
  const encKey = await encryptAesKeyWithRsaPublicKey(rsa.publicKey, aesKey);

  const receiver = buildReceiver({ rsa });
  await receiver.onMetaData('file-3', {
    name: 'ok.bin',
    size: 300,
    type: 'application/octet-stream',
    key: encKey
  });

  const file = receiver.state.receivingFiles['file-3'];
  assert.equal(file.error, undefined, 'a valid key must not error the entry');
  assert.ok(file.aesKey, 'a valid key must decrypt and attach the AES key');
  assert.equal(file.status, 'Processing', 'autoAccept must move the entry to Processing');
  assert.equal(
    receiver.frameCount(),
    1,
    'a valid key must produce exactly one outbound frame (the accept)'
  );
  assert.equal(
    receiver.decodeAll()[0].receiveEvent,
    ReceiveEvent.EVENT_RECEIVER_ACCEPT,
    'a valid key must be accepted, not rejected'
  );
  assert.equal(receiver.toasts.length, 0, 'a clean decrypt must not toast');
  console.log('ok - valid key: accepted with EVENT_RECEIVER_ACCEPT, no false validate error');
}

// ---- Test 4: static guard — the component's catch block signals before return ----
{
  const source = await readFile(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );

  // Isolate the onMetaData() function body via brace matching.
  const fnStart = source.search(/export\s+async\s+function\s+onMetaData\s*\(/);
  assert.ok(fnStart !== -1, 'onMetaData() must exist in Receiver.svelte');
  const bodyStart = source.indexOf('{', fnStart);
  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        bodyEnd = i + 1;
        break;
      }
    }
  }
  assert.ok(bodyEnd !== -1, 'onMetaData(): unbalanced braces');
  const body = source.slice(bodyStart, bodyEnd);

  // Isolate the key-decryption catch block: the first "} catch" after the
  // decryptAesKeyWithRsaPrivateKey call.
  const decryptCall = body.indexOf('decryptAesKeyWithRsaPrivateKey');
  assert.ok(
    decryptCall !== -1,
    'onMetaData must decrypt the key via decryptAesKeyWithRsaPrivateKey'
  );
  const catchStart = body.indexOf('} catch', decryptCall);
  assert.ok(catchStart !== -1, 'the key decryption must be wrapped in a try/catch');
  const catchBodyStart = body.indexOf('{', catchStart);
  let cDepth = 0;
  let catchBodyEnd = -1;
  for (let i = catchBodyStart; i < body.length; i++) {
    if (body[i] === '{') cDepth++;
    else if (body[i] === '}') {
      cDepth--;
      if (cDepth === 0) {
        catchBodyEnd = i + 1;
        break;
      }
    }
  }
  assert.ok(catchBodyEnd !== -1, 'the key-decryption catch block: unbalanced braces');
  const catchBody = body.slice(catchBodyStart, catchBodyEnd);

  // The local error + toast must still be present (existing behavior kept).
  assert.ok(
    /receivingFiles\[id\]\.error\s*=/.test(catchBody),
    'the catch block must still mark the entry errored locally'
  );
  assert.ok(/addToastMessage/.test(catchBody), 'the catch block must still surface a local toast');

  // The new behavior: an outbound signal over the channel, strictly before the
  // return that ends the handler.
  const sendIdx = catchBody.indexOf('dataChannel.send');
  assert.ok(
    sendIdx !== -1,
    'the key-decryption catch must send a signal back to the peer (no local-only failure)'
  );
  const encodeIdx = catchBody.indexOf('Message.encode');
  assert.ok(
    encodeIdx !== -1 && encodeIdx > sendIdx,
    'the signal must be built via Message.encode inside dataChannel.send'
  );
  assert.ok(
    catchBody.includes('ReceiveEvent.EVENT_VALIDATE_ERROR') ||
      catchBody.includes('ReceiveEvent.EVENT_RECEIVER_REJECT'),
    'the signal must be EVENT_VALIDATE_ERROR or EVENT_RECEIVER_REJECT (the two events the sender handles out of WaitingAccept)'
  );
  assert.ok(
    !catchBody.includes('ReceiveEvent.EVENT_RECEIVER_ACCEPT'),
    'the failure path must never send an accept'
  );
  const returnIdx = catchBody.lastIndexOf('return');
  assert.ok(
    returnIdx !== -1 && sendIdx < returnIdx,
    'the outbound signal must be sent before the catch block returns'
  );
  console.log(
    'ok - component source: onMetaData key-decryption catch signals the peer before returning'
  );
}

console.log(
  'ok - receiver metadata key-decryption failure now signals the sender (no more permanent Waiting Accept)'
);
