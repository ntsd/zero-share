// Regression guard for P0 "unguarded receivingFiles[id] access in the
// onMetaData() CATCH path — Deny/Remove during the key-decryption await throws
// an unhandled TypeError on the error-assignment".
//
// The same failure class as tests/receiver-metadata-key-null-guard.test.mjs
// (success path `receivingFiles[id].aesKey =` after the await), but on the
// catch branch of the key-decryption try/await in
// Receiver.svelte#onMetaData():
//
//     } catch {
//       receivingFiles[id].error = new Error('Failed to decrypt the file key');
//
// Both writes sit after the same `await decryptAesKeyWithRsaPrivateKey(...)`
// suspension point. The entry is registered up front as WaitingAccept, and
// post-#76 ReceivingFileList renders Accept/Deny for WaitingAccept entries —
// so while the (slow) RSA-OAEP WebCrypto call is still running, the user can
// click Deny (onDeny does `delete receivingFiles[key]`, exactly like
// onRemove). When the decrypt then REJECTS — which is the only way the catch
// block ever runs — the post-await error-assignment dereferences the deleted
// entry and throws
//   TypeError: Cannot set properties of undefined (setting 'error')
// outside any try/catch in the async function. The rejection is unhandled
// (handlePeerMessage calls handlers.onMetaData(...) without awaiting, and
// nothing in the data-channel onmessage path has a catch): the
// addToastMessage and the send(EVENT_VALIDATE_ERROR) that follow never run,
// so the user gets no feedback and the sender's file sits in WaitingAccept
// forever.
//
// (The previous #101 task description dismissed this line, claiming the catch
// path "is only reached when the entry still exists." Wrong: the catch path
// is reached exactly when the decrypt rejects, and that await is precisely
// the window in which Deny/Remove can delete the entry.)
//
// The Svelte component is not importable in plain Node, so (matching
// tests/receiver-metadata-key-null-guard.test.mjs) this test mirrors the
// onMetaData catch shape with a mocked decrypt that runs onDeny BEFORE it
// rejects, driving the pre-fix shape (proving the mock reproduces the
// unhandled rejection) and the post-fix shape (proving no exception escapes
// and the toast/sender-bounce side effects are skipped for the removed file),
// plus a static guard on the real component.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// FileStatus values, mirrored from src/type.ts (Svelte/TS not importable here).
const FileStatus = {
  Pending: 'Pending',
  WaitingAccept: 'WaitingAccept',
  Processing: 'Processing',
  Success: 'Success'
};

// Mock decryptAesKeyWithRsaPrivateKey: runs `deny` (the user clicking Deny on
// the WaitingAccept entry) synchronously BEFORE its promise rejects, then
// rejects in a later macrotask. The onMetaData catch continuation therefore
// resumes after the entry has been deleted — the exact race window from the
// bug report (the RSA key-decryption await is the suspension point, and the
// catch block only runs when that await rejects).
function mockDecryptThatDeniesThenRejects(deny, id) {
  deny(id);
  return new Promise((resolve, reject) =>
    setTimeout(() => reject(new Error('mock RSA-OAEP decrypt failed')), 0)
  );
}

function makeState() {
  return {
    receivingFiles: {},
    receivingFileChunkMap: {},
    receivingFileStatsMap: {},
    chunkQueue: {}
  };
}

// The guarded onDeny, mirrored from Receiver.svelte post-#76: send the reject
// signal, tear down the per-file maps, delete the entry.
function makeOnDeny(state, sentFrames) {
  return function onDeny(key) {
    sentFrames.push({ id: key, receiveEvent: 'RECEIVER_REJECT' });
    delete state.receivingFileChunkMap[key];
    delete state.receivingFileStatsMap[key];
    delete state.chunkQueue[key];
    delete state.receivingFiles[key];
  };
}

// ---- Test 1 (onMetaData catch): PRE-FIX control — unguarded error write ----
// Proves the mock race actually produces the uncaught TypeError, i.e. this
// setup would have caught the original bug.
{
  const ID = 'file-1';
  const state = makeState();
  const sentFrames = [];
  const toasts = [];
  const onDeny = makeOnDeny(state, sentFrames);

  // PRE-FIX shape: the catch block writes `receivingFiles[id].error` with no
  // existence guard (the original line-66 shape).
  async function onMetaData(id, metaData) {
    state.receivingFiles[id] = {
      metaData: metaData,
      progress: 0,
      bitrate: 0,
      startTime: 0,
      status: FileStatus.WaitingAccept
    };
    try {
      await mockDecryptThatDeniesThenRejects(onDeny, id);
    } catch {
      state.receivingFiles[id].error = new Error('Failed to decrypt the file key'); // crash site
      toasts.push(`${metaData.name} failed to decrypt the file key`);
      sentFrames.push({ id: id, receiveEvent: 'VALIDATE_ERROR' });
      return;
    }
  }

  await assert.rejects(
    onMetaData(ID, { name: 'a.bin', size: 300, type: 'application/octet-stream' }),
    (err) => {
      assert.ok(err instanceof TypeError, 'must be a TypeError, got ' + err.constructor.name);
      assert.match(String(err), /Cannot set properties of undefined \(setting 'error'\)/);
      return true;
    },
    'pre-fix onMetaData catch must reject with TypeError when Deny lands in the decryption window'
  );
  assert.equal(state.receivingFiles[ID], undefined, 'the entry was denied mid-flight');
  assert.equal(
    toasts.length,
    0,
    'the crash must prevent the toast from firing (the rejection escapes before it)'
  );
  assert.equal(
    sentFrames.filter((f) => f.receiveEvent === 'VALIDATE_ERROR').length,
    0,
    'the crash must skip the EVENT_VALIDATE_ERROR — the sender is never bounced'
  );
  await delay(10);
  console.log(
    'ok - control: pre-fix onMetaData catch rejects with uncaught TypeError on Deny during key decryption'
  );
}

// ---- Test 2 (onMetaData catch): POST-FIX — null-guarded; denied entry is a no-op
{
  const ID = 'file-2';
  const state = makeState();
  const sentFrames = [];
  const toasts = [];
  const onDeny = makeOnDeny(state, sentFrames);

  // POST-FIX shape: the catch block re-reads the entry and bails when it was
  // denied during the decryption window.
  async function onMetaData(id, metaData) {
    state.receivingFiles[id] = {
      metaData: metaData,
      progress: 0,
      bitrate: 0,
      startTime: 0,
      status: FileStatus.WaitingAccept
    };
    try {
      await mockDecryptThatDeniesThenRejects(onDeny, id);
    } catch {
      const metaEntry = state.receivingFiles[id];
      if (!metaEntry) return; // denied/removed during the decryption window
      metaEntry.error = new Error('Failed to decrypt the file key');
      toasts.push(`${metaData.name} failed to decrypt the file key`);
      sentFrames.push({ id: id, receiveEvent: 'VALIDATE_ERROR' });
      return;
    }
  }

  // Must RESOLVE (no exception), not reject.
  await onMetaData(ID, { name: 'a.bin', size: 300, type: 'application/octet-stream' });
  assert.equal(state.receivingFiles[ID], undefined, 'the entry stays denied/removed');
  assert.equal(toasts.length, 0, 'no toast may fire for a file the user already denied');
  assert.equal(
    sentFrames.filter((f) => f.receiveEvent === 'VALIDATE_ERROR').length,
    0,
    'no EVENT_VALIDATE_ERROR may be sent for the denied file (the user already rejected it)'
  );
  assert.equal(
    sentFrames.filter((f) => f.receiveEvent === 'RECEIVER_REJECT').length,
    1,
    'only the Deny click itself signaled the sender'
  );
  await delay(10);
  console.log(
    'ok - post-fix onMetaData catch resolves cleanly when the file is denied mid-decryption'
  );
}

// ---- Test 3 (onMetaData catch): POST-FIX — entry still present, full error path runs
{
  const ID = 'file-3';
  const state = makeState();
  const sentFrames = [];
  const toasts = [];
  const onDeny = makeOnDeny(state, sentFrames); // defined but never called (no Deny click)

  async function onMetaData(id, metaData) {
    state.receivingFiles[id] = {
      metaData: metaData,
      progress: 0,
      bitrate: 0,
      startTime: 0,
      status: FileStatus.WaitingAccept
    };
    try {
      await new Promise((resolve, reject) =>
        setTimeout(() => reject(new Error('mock RSA-OAEP decrypt failed')), 0)
      );
    } catch {
      const metaEntry = state.receivingFiles[id];
      if (!metaEntry) return; // denied/removed during the decryption window
      metaEntry.error = new Error('Failed to decrypt the file key');
      toasts.push(`${metaData.name} failed to decrypt the file key`);
      sentFrames.push({ id: id, receiveEvent: 'VALIDATE_ERROR' });
      return;
    }
  }

  await onMetaData(ID, { name: 'b.bin', size: 300, type: 'application/octet-stream' });
  const file = state.receivingFiles[ID];
  assert.ok(file.error instanceof Error, 'a failed key must still error the live entry');
  assert.match(
    file.error.message,
    /decrypt/i,
    'the error must describe the key-decryption failure'
  );
  assert.equal(
    file.status,
    FileStatus.WaitingAccept,
    'the errored entry must stay WaitingAccept (actionable)'
  );
  assert.equal(
    toasts.length,
    1,
    'the failure must still surface a local toast when the entry survives'
  );
  assert.equal(
    sentFrames.filter((f) => f.receiveEvent === 'VALIDATE_ERROR').length,
    1,
    'the failure must still bounce the sender with EVENT_VALIDATE_ERROR when the entry survives'
  );
  await delay(10);
  console.log(
    'ok - post-fix onMetaData catch still errors the entry + toasts + bounces the sender when it survives'
  );
}

// ---- Test 4: static guard — the real component null-guards the catch-path error write
{
  const receiverSource = readFileSync(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );

  // Isolate the key-decryption catch block body: the first "} catch" after
  // onMetaData's decryptAesKeyWithRsaPrivateKey call, then brace-match its
  // body. (Only the catch body is scanned: the validate-error path's
  // `receivingFiles[id].error = validateErr;` is untouched and safe — after
  // the post-#101 guard bails early on a removed entry, no `await` intervenes
  // before that write.)
  const bodyStart = receiverSource.indexOf('export async function onMetaData');
  assert.ok(bodyStart !== -1, 'onMetaData() must exist in Receiver.svelte');
  const decryptCall = receiverSource.indexOf('decryptAesKeyWithRsaPrivateKey', bodyStart);
  assert.ok(decryptCall !== -1, 'onMetaData must decrypt the key');
  const catchIdx = receiverSource.indexOf('} catch', decryptCall);
  assert.ok(catchIdx !== -1, 'the key decryption must be wrapped in a try/catch');
  const catchBodyStart = receiverSource.indexOf('{', catchIdx);
  let depth = 0;
  let catchBodyEnd = -1;
  for (let i = catchBodyStart; i < receiverSource.length; i++) {
    if (receiverSource[i] === '{') depth++;
    else if (receiverSource[i] === '}') {
      depth--;
      if (depth === 0) {
        catchBodyEnd = i + 1;
        break;
      }
    }
  }
  assert.ok(catchBodyEnd !== -1, 'the key-decryption catch block: unbalanced braces');
  const catchBody = receiverSource.slice(catchBodyStart, catchBodyEnd);

  // The original crash site — the unguarded bare re-read assignment in the
  // key-decryption catch — must be gone.
  assert.ok(
    !/receivingFiles\[id\]\.error\s*=/.test(catchBody),
    'the key-decryption catch must not write the error via an unguarded receivingFiles[id].error re-read'
  );

  // The post-fix shape: the catch block re-reads the same key it just
  // registered and bails on a missing entry (denied during the window)
  // before the error write.
  assert.ok(
    /receivingFiles\[id\];/.test(catchBody),
    'the catch block must re-read receivingFiles[id]'
  );
  assert.ok(
    /if\s*\(\s*!\w+\s*\)\s*return;/.test(catchBody),
    'the catch block must bail when the re-read entry is missing (denied/removed during the decryption window)'
  );
  assert.ok(
    /(\w+)\.error\s*=\s*new Error\('Failed to decrypt the file key'\)/.test(catchBody),
    'the catch block must still mark the entry errored locally (via the guarded re-read)'
  );
  // The guarded bail must come BEFORE the error write.
  const guardIdx = catchBody.search(/if\s*\(\s*!\w+\s*\)\s*return;/);
  const errorIdx = catchBody.indexOf("new Error('Failed to decrypt the file key')");
  assert.ok(
    guardIdx !== -1 && errorIdx !== -1 && guardIdx < errorIdx,
    'the null-guard must precede the error-assignment in the catch block'
  );
  console.log('ok - static: Receiver.svelte onMetaData catch null-guards the error write');
}

console.log(
  'ok - receiver onMetaData catch path: no uncaught TypeError when Deny lands in the key-decryption window'
);
