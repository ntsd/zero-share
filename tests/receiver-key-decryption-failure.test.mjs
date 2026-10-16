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

// Faithful mirror of the Receiver.svelte state machine under test: onMetaData
// (register -> RSA key decrypt -> on failure: local error + toast + outbound
// EVENT_VALIDATE_ERROR + return) plus the post-#76/#fix onAccept() entry
// point — a metadata-failed entry (error set / aesKey missing) is refused:
// explanatory toast + EVENT_RECEIVER_REJECT, entry stays WaitingAccept, and NO
// chunk map is created (so onChunkData drops any late-arriving chunks).
function buildReceiver({ rsa, autoAccept = true }) {
  const isEncrypt = true;
  const state = {
    receivingFiles: {},
    chunkMap: {} // mirror of the component's non-state receivingFileChunkMap
  };
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
      onAccept(id);
    }
  }

  // Mirror of Receiver.svelte#onAccept (post-fix): refuse metadata-failed
  // entries (error set, or encrypted session without an aesKey) with a toast +
  // REJECT, no state change and no chunk map; otherwise signal ACCEPT and
  // create the chunk maps.
  function onAccept(id) {
    const receivingFile = state.receivingFiles[id];
    if (receivingFile?.error || (isEncrypt && !receivingFile?.aesKey)) {
      toasts.push(
        `Cannot accept ${receivingFile?.metaData?.name ?? id}: the metadata/key failed to process — the sender must resend the file`
      );
      dataChannel.send(
        Message.encode({
          id: id,
          receiveEvent: ReceiveEvent.EVENT_RECEIVER_REJECT
        }).finish()
      );
      return;
    }

    dataChannel.send(
      Message.encode({
        id: id,
        receiveEvent: ReceiveEvent.EVENT_RECEIVER_ACCEPT
      }).finish()
    );

    state.receivingFiles[id].status = 'Processing';
    state.receivingFiles[id].startTime = Date.now();

    state.chunkMap[id] = { receivedChunks: [] };
  }

  function decodeAll() {
    return sentFrames.map((f) => Message.decode(f));
  }

  return {
    state,
    toasts,
    onMetaData,
    onAccept,
    decodeAll,
    frameCount: () => sentFrames.length
  };
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
  // return that ends the handler. The call goes through the component's
  // guarded send() helper (post connection-lost fix: every send is readyState-
  // guarded so a dead channel no-ops instead of throwing InvalidStateError),
  // so match `send(` or the legacy `dataChannel.send(`.
  const sendIdx = catchBody.search(/(?:dataChannel\.)?send\(/);
  assert.ok(
    sendIdx !== -1,
    'the key-decryption catch must send a signal back to the peer (no local-only failure)'
  );
  const encodeIdx = catchBody.indexOf('Message.encode');
  assert.ok(
    encodeIdx !== -1 && encodeIdx > sendIdx,
    'the signal must be built via Message.encode inside the send call'
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

// ---- Test 5: manual-accept mode (autoAccept=false) + failing key -> entry
// ---- stays WaitingAccept + error and is still actionable (not auto-advanced,
// ---- not bounced to Pending) ----
// This is the exact state the UI gating fix (ReceivingFileList.svelte) must
// keep actionable: in manual mode a failed-metadata entry must still be able
// to receive Accept/Deny instead of dead-ending on Remove only.
{
  const rsa = await generateRsaKeyPair();
  const receiver = buildReceiver({ rsa, autoAccept: false });
  await receiver.onMetaData('file-4', {
    name: 'manual.bin',
    size: 512,
    type: 'application/octet-stream',
    key: new Uint8Array(0) // empty key: the RSA-OAEP decrypt genuinely throws
  });

  const file = receiver.state.receivingFiles['file-4'];
  assert.ok(
    file.error instanceof Error,
    'manual mode: a failed key must still error the entry locally'
  );
  assert.match(
    file.error.message,
    /decrypt/i,
    'manual mode: the error must describe the key-decryption failure'
  );
  // The entry must REMAIN in WaitingAccept: not auto-advanced to Processing
  // (autoAccept is off) and not cosmetically bounced to Pending — only that
  // state keeps Accept/Deny reachable for the user.
  assert.equal(
    file.status,
    'WaitingAccept',
    'manual mode + failed key must stay WaitingAccept (actionable), not advance or bounce to Pending'
  );
  assert.equal(file.aesKey, undefined, 'no AES key may be attached to a failed entry');

  // Exactly one outbound signal (VALIDATE_ERROR) and NO accept: the sender is
  // told the metadata failed, but the receiver must not accept a key it cannot
  // decrypt.
  assert.equal(
    receiver.frameCount(),
    1,
    'manual mode: a key-decryption failure must produce exactly one outbound signal'
  );
  const decoded = receiver.decodeAll();
  assert.equal(
    decoded[0].receiveEvent,
    ReceiveEvent.EVENT_VALIDATE_ERROR,
    'manual mode: the outbound signal must be EVENT_VALIDATE_ERROR so the sender recovers'
  );
  assert.equal(decoded[0].id, 'file-4', 'manual mode: the signal must target the failed file id');
  assert.ok(
    !decoded.some((m) => m.receiveEvent === ReceiveEvent.EVENT_RECEIVER_ACCEPT),
    'manual mode: no accept may be sent for a file whose key failed to decrypt'
  );
  console.log(
    'ok - manual accept + failed key: entry stays WaitingAccept+error, exactly one EVENT_VALIDATE_ERROR, no accept'
  );
}

// ---- Test 6: manual-accept mode (autoAccept=false) + VALID key -> entry
// ---- stays WaitingAccept with NO accept frame (manual mode never auto-
// ---- advances) ----
// Control that a "fix" for the manual dead-end does not accidentally make
// manual mode auto-accept: a healthy entry still waits on an explicit user
// click, so the Accept/Deny buttons are what actually drive it forward.
{
  const rsa = await generateRsaKeyPair();
  const aesKey = await generateAesKey();
  const encKey = await encryptAesKeyWithRsaPublicKey(rsa.publicKey, aesKey);

  const receiver = buildReceiver({ rsa, autoAccept: false });
  await receiver.onMetaData('file-5', {
    name: 'manual-ok.bin',
    size: 300,
    type: 'application/octet-stream',
    key: encKey
  });

  const file = receiver.state.receivingFiles['file-5'];
  assert.equal(file.error, undefined, 'manual mode: a valid key must not error the entry');
  assert.ok(file.aesKey, 'manual mode: a valid key must decrypt and attach the AES key');
  assert.equal(
    file.status,
    'WaitingAccept',
    'manual mode must NOT auto-advance a healthy entry; it stays Waiting Accept for the user'
  );
  assert.equal(
    receiver.frameCount(),
    0,
    'manual mode: no outbound frame until the user explicitly accepts'
  );
  assert.equal(receiver.toasts.length, 0, 'manual mode: a clean decrypt must not toast');
  console.log('ok - manual accept + valid key: stays Waiting Accept, no auto-accept frame');
}

// ---- Test 7: static guard — ReceivingFileList.svelte keeps Accept/Deny for
// ---- WaitingAccept entries even when `error` is set ----
// The P0 dead-end lived here: the Accept/Deny branch was gated on
// `status === WaitingAccept && !error`, so a failed-metadata entry
// (WaitingAccept + error) fell through to the else branch and rendered
// Remove only. The fix drops the error clause so such entries stay
// actionable; this guard forbids the clause coming back.
{
  const source = await readFile(
    join(here, '..', 'src', 'components', 'receiver', 'ReceivingFileList.svelte'),
    'utf8'
  );

  // The template lives after the closing </script>.
  const scriptEnd = source.indexOf('</script>');
  assert.ok(scriptEnd !== -1, 'ReceivingFileList.svelte must have a <script> block');
  const template = source.slice(scriptEnd);

  // Find the {#if} that gates the Accept/Deny buttons: the one whose
  // condition references the WaitingAccept status.
  const ifMatch = template.match(/\{#if\s+([^}]*)WaitingAccept[^}]*\}/);
  assert.ok(
    ifMatch,
    'ReceivingFileList.svelte must branch on FileStatus.WaitingAccept to offer Accept/Deny'
  );
  const condition = ifMatch[1];

  // THE FIX: the condition must NOT gate the buttons on the absence of an
  // error. A metadata-failed entry (WaitingAccept + error) must stay
  // actionable — the `!error` clause is exactly what dead-ended it.
  assert.ok(
    !/error/i.test(condition),
    'the WaitingAccept branch must NOT gate Accept/Deny on the absence of an error (that clause left failed-metadata entries with Remove only)'
  );

  // The branch body (between the {#if ...} and its {:else}) must still carry
  // both an Accept and a Deny button.
  const ifAbs = template.indexOf(ifMatch[0]);
  const elseIdx = template.indexOf('{:else}', ifAbs);
  assert.ok(elseIdx !== -1, 'the WaitingAccept branch must have an else branch (Remove)');
  const branchBody = template.slice(ifAbs + ifMatch[0].length, elseIdx);
  assert.ok(
    /onAccept\s*\(\s*key\s*\)/.test(branchBody),
    'the WaitingAccept branch must render an Accept button'
  );
  assert.ok(
    /onDeny\s*\(\s*key\s*\)/.test(branchBody),
    'the WaitingAccept branch must render a Deny button'
  );
  console.log(
    'ok - component source: WaitingAccept entries (incl. failed-metadata) still render Accept/Deny, not Remove-only'
  );
}

// ---- Test 8: manual-accept mode + failed key + onAccept() -> refused: no
// ---- ACCEPT frame, entry stays WaitingAccept + error, no chunk map, at most
// ---- a REJECT ----
// The P0 from the #76 follow-up: in manual mode the Accept button is rendered
// for a failed-metadata entry (#76), so onAccept() must guard the entry's
// error/aesKey state instead of starting a transfer that can never succeed
// (ciphertext assembled as a Success blob, or an N-toast corrupt-chunk storm
// per resend).
{
  const rsa = await generateRsaKeyPair();
  const receiver = buildReceiver({ rsa, autoAccept: false });
  await receiver.onMetaData('file-6', {
    name: 'manual-fail.bin',
    size: 512,
    type: 'application/octet-stream',
    key: new Uint8Array(0) // empty key: the RSA-OAEP decrypt genuinely throws
  });

  receiver.onAccept('file-6');

  const file = receiver.state.receivingFiles['file-6'];
  assert.equal(
    file.status,
    'WaitingAccept',
    'a refused accept must leave the entry in WaitingAccept (Deny/Remove stay available)'
  );
  assert.ok(
    file.error instanceof Error,
    "a refused accept must not clear the entry's metadata error"
  );
  assert.equal(file.aesKey, undefined, 'a refused accept must not attach an AES key');
  assert.equal(file.blob, undefined, 'a refused accept must not start assembling any file content');

  // No ACCEPT may go out for a metadata-failed entry — only the original
  // VALIDATE_ERROR, and at most one REJECT from the refusal.
  const decoded = receiver.decodeAll();
  assert.ok(
    !decoded.some((m) => m.receiveEvent === ReceiveEvent.EVENT_RECEIVER_ACCEPT),
    'onAccept on a metadata-failed entry must NOT send EVENT_RECEIVER_ACCEPT'
  );
  assert.ok(
    decoded.filter((m) => m.receiveEvent === ReceiveEvent.EVENT_RECEIVER_REJECT).length <= 1,
    'at most one REJECT may be sent for the refused accept'
  );
  // The refusal is user-visible instead of a silent dead-end.
  assert.ok(
    receiver.toasts.some((t) => /cannot accept/i.test(t)),
    'the refusal must surface a toast explaining the accept failed'
  );
  // No chunk map may be created: onChunkData then drops any late-arriving
  // chunks for this id instead of counting ciphertext toward receivedSize.
  assert.equal(
    receiver.state.chunkMap['file-6'],
    undefined,
    'a refused accept must not create a chunk map for the file'
  );
  console.log(
    'ok - manual accept on failed key: no ACCEPT, entry stays WaitingAccept+error, no chunk map'
  );
}

// ---- Test 9: static guard — Receiver.svelte#onAccept guards the entry's
// ---- error state before sending EVENT_RECEIVER_ACCEPT ----
// The regression lived here: onAccept() accepted unconditionally, so a
// metadata-failed entry (error set / aesKey undefined) started a transfer
// that could only produce a garbage "Success" blob or a corrupt-chunk toast
// storm. This guard requires the error/aesKey check to precede the ACCEPT
// frame.
{
  const source = await readFile(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );

  // Isolate the onAccept() function body via brace matching.
  const fnStart = source.search(/function\s+onAccept\s*\(/);
  assert.ok(fnStart !== -1, 'onAccept() must exist in Receiver.svelte');
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
  assert.ok(bodyEnd !== -1, 'onAccept(): unbalanced braces');
  const body = source.slice(bodyStart, bodyEnd);

  const acceptIdx = body.indexOf('ReceiveEvent.EVENT_RECEIVER_ACCEPT');
  assert.ok(acceptIdx !== -1, 'onAccept() must send EVENT_RECEIVER_ACCEPT for valid entries');

  // The guard must read the live entry and its error BEFORE the ACCEPT frame
  // is built, and refuse when the session is encrypted but the key is
  // missing.
  const guardIdx = body.search(/\.error\b/);
  assert.ok(
    guardIdx !== -1 && guardIdx < acceptIdx,
    "onAccept() must check the entry's error state before sending EVENT_RECEIVER_ACCEPT"
  );
  assert.ok(
    body.includes('isEncrypt') && body.includes('aesKey'),
    'onAccept() must also refuse an encrypted entry without a usable aesKey'
  );
  // The refusal path signals the sender (so it cannot sit in WaitingAccept
  // for an undeliverable file) without advancing the local entry.
  assert.ok(
    body.includes('ReceiveEvent.EVENT_RECEIVER_REJECT'),
    'the refusal path should reject the file so the sender recovers'
  );
  console.log('ok - component source: onAccept guards error/aesKey before sending ACCEPT');
}

console.log(
  'ok - receiver metadata key-decryption failure now signals the sender (no more permanent Waiting Accept)'
);
