// Regression guard for P0 "unguarded receivingFiles[id] access after the
// async key-decryption await in Receiver.svelte onMetaData() — Remove during
// the decryption window crashes the page via uncaught TypeError".
//
// onMetaData registers the file entry up front (so it is visible AND
// removable throughout the async window), then awaits RSA key decryption for
// encrypted sessions. After that await the success path re-dereferenced the
// entry through the $state proxy with NO null guard:
//
//     receivingFiles[id].aesKey = aesKey;
//
// onRemove(key) does `delete receivingFiles[key]`, so if the user clicks
// Remove while the (slow) RSA-OAEP WebCrypto call is still running, the
// post-await assignment throws
//   TypeError: Cannot set properties of undefined (setting 'aesKey')
// outside any try/catch in the async function — the rejection is unhandled
// (the data-channel onmessage caller does not await onMetaData): no toast,
// no error state, the file silently vanishes, and the sender never gets an
// EVENT_VALIDATE_ERROR / EVENT_RECEIVER_REJECT so its file sits in
// WaitingAccept forever.
//
// Every OTHER path in this file already null-guards the same access
// (onChunkData, processChunk, onRemove, onDownload, onAccept, onDeny);
// line 79 was the one missing it. The fix re-reads receivingFiles[id] and
// bails when the entry was removed in the decryption window, the same shape
// as onRemove/onDownload.
//
// The Svelte component is not importable in plain Node, so (matching
// tests/sender-remove-inflight.test.mjs and
// tests/receiver-remove-download-null-guard.test.mjs) this test mirrors the
// onMetaData shape with a mocked decrypt that runs onRemove BEFORE it
// settles, driving the pre-fix shape (proving the mock reproduces the race)
// and the post-fix shape (proving no exception escapes and no accept/validate
// side effects fire for the removed file), plus a static guard on the real
// component.
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

// Mock decryptAesKeyWithRsaPrivateKey: runs `remove` (the user clicking
// Remove on the WaitingAccept entry) synchronously BEFORE its promise
// settles, then resolves in a later microtask. The onMetaData continuation
// therefore resumes after the entry has been deleted — the exact race window
// from the bug report (the RSA key-decryption await is the suspension point).
function mockDecryptThatRemoves(remove, id) {
  remove(id);
  return new Promise((resolve) => setTimeout(() => resolve('mock-aes-key'), 0));
}

function makeState() {
  return {
    receivingFiles: {},
    receivingFileChunkMap: {},
    receivingFileStatsMap: {},
    chunkQueue: {}
  };
}

// The guarded onRemove, mirrored from Receiver.svelte post-fix: capture the
// entry, bail if gone, then delete it.
function makeOnRemove(state) {
  return function onRemove(key) {
    const f = state.receivingFiles[key];
    if (!f) return;
    delete state.receivingFileChunkMap[key];
    delete state.receivingFileStatsMap[key];
    delete state.chunkQueue[key];
    delete state.receivingFiles[key];
  };
}

// ---- Test 1 (onMetaData): PRE-FIX control — unguarded post-await write -----
// Proves the mock latency actually produces the uncaught TypeError, i.e. this
// setup would have caught the original bug.
{
  const ID = 'file-1';
  const state = makeState();
  state.receivingFiles[ID] = {
    metaData: { name: 'a.bin', size: 300, type: 'application/octet-stream' },
    progress: 0,
    bitrate: 0,
    startTime: 0,
    status: FileStatus.WaitingAccept
  };
  const onRemove = makeOnRemove(state);
  let accepted = false;

  // PRE-FIX shape: re-reads `receivingFiles[id]` after the decryption await
  // with no existence guard (the original line-79 shape).
  async function onMetaData(id, metaData) {
    state.receivingFiles[id] = {
      metaData: metaData,
      progress: 0,
      bitrate: 0,
      startTime: 0,
      status: FileStatus.WaitingAccept
    };
    const aesKey = await mockDecryptThatRemoves(onRemove, id);
    state.receivingFiles[id].aesKey = aesKey; // crash site
    accepted = true;
  }

  await assert.rejects(
    onMetaData(ID, { name: 'a.bin', size: 300, type: 'application/octet-stream' }),
    (err) => {
      assert.ok(err instanceof TypeError, 'must be a TypeError, got ' + err.constructor.name);
      assert.match(String(err), /Cannot set properties of undefined \(setting 'aesKey'\)/);
      return true;
    },
    'pre-fix onMetaData must reject with TypeError when Remove lands in the decryption window'
  );
  assert.equal(state.receivingFiles[ID], undefined, 'the entry was removed mid-flight');
  assert.equal(accepted, false, 'no accept/validate side effect must fire for the removed file');
  await delay(10);
  console.log(
    'ok - control: pre-fix onMetaData rejects with uncaught TypeError on Remove during decryption'
  );
}

// ---- Test 2 (onMetaData): POST-FIX — null-guarded; removed entry is a no-op --
{
  const ID = 'file-2';
  const state = makeState();
  state.receivingFiles[ID] = {
    metaData: { name: 'a.bin', size: 300, type: 'application/octet-stream' },
    progress: 0,
    bitrate: 0,
    startTime: 0,
    status: FileStatus.WaitingAccept
  };
  const onRemove = makeOnRemove(state);
  let accepted = false;

  // POST-FIX shape: re-reads the entry after the await and bails when it was
  // removed during the decryption window.
  async function onMetaData(id, metaData) {
    state.receivingFiles[id] = {
      metaData: metaData,
      progress: 0,
      bitrate: 0,
      startTime: 0,
      status: FileStatus.WaitingAccept
    };
    const aesKey = await mockDecryptThatRemoves(onRemove, id);
    const entry = state.receivingFiles[id];
    if (!entry) return; // removed during the decryption window
    entry.aesKey = aesKey;
    accepted = true;
  }

  // Must RESOLVE (no exception), not reject.
  await onMetaData(ID, { name: 'a.bin', size: 300, type: 'application/octet-stream' });
  assert.equal(state.receivingFiles[ID], undefined, 'the entry stays removed');
  assert.equal(accepted, false, 'no accept/validate side effect may fire for the removed file');
  await delay(10);
  console.log('ok - post-fix onMetaData resolves cleanly when the file is removed mid-decryption');
}

// ---- Test 3 (onMetaData): POST-FIX — entry still present, assignment proceeds --
{
  const ID = 'file-3';
  const state = makeState();
  state.receivingFiles[ID] = {
    metaData: { name: 'a.bin', size: 300, type: 'application/octet-stream' },
    progress: 0,
    bitrate: 0,
    startTime: 0,
    status: FileStatus.WaitingAccept
  };
  const onRemove = makeOnRemove(state); // defined but never called (no Remove click)
  let accepted = false;

  async function onMetaData(id, metaData) {
    state.receivingFiles[id] = {
      metaData: metaData,
      progress: 0,
      bitrate: 0,
      startTime: 0,
      status: FileStatus.WaitingAccept
    };
    const aesKey = await new Promise((resolve) => setTimeout(() => resolve('mock-aes-key'), 0));
    const entry = state.receivingFiles[id];
    if (!entry) return;
    entry.aesKey = aesKey;
    accepted = true;
  }

  await onMetaData(ID, { name: 'a.bin', size: 300, type: 'application/octet-stream' });
  assert.equal(
    state.receivingFiles[ID].aesKey,
    'mock-aes-key',
    'the key must land on the live entry'
  );
  assert.equal(accepted, true, 'the post-metadata flow (validate/auto-accept) must still run');
  await delay(10);
  console.log(
    'ok - post-fix onMetaData still assigns the key and continues when the entry survives'
  );
}

// ---- Test 4: static guard — the real component carries the post-await guard --
{
  const receiverSource = readFileSync(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );

  // The original crash site — the unguarded bare re-read assignment — must be gone.
  assert.ok(
    !/receivingFiles\[id\]\.aesKey\s*=/.test(receiverSource),
    'onMetaData must not assign aesKey via an unguarded receivingFiles[id].aesKey re-read'
  );

  // The post-fix shape: re-read the same key after the decryption await and
  // bail on a missing entry (removed during the window) before the assignment.
  assert.ok(
    /const\s+\w+\s*=\s*receivingFiles\[id\];\s*if\s*\(\s*!\w+\s*\)\s*return;/.test(receiverSource),
    'onMetaData must re-read receivingFiles[id] and null-guard it before the post-await assignment'
  );
  assert.ok(
    /entry\.aesKey\s*=\s*aesKey;/.test(receiverSource),
    'onMetaData must assign aesKey through the null-guarded re-read entry'
  );

  // The registration still happens up front (the documented removal window).
  assert.ok(
    /receivingFiles\[id\]\s*=\s*\{[\s\S]*?status:\s*FileStatus\.WaitingAccept\s*\};/.test(
      receiverSource
    ),
    'onMetaData must still register the WaitingAccept entry up front'
  );

  console.log('ok - static: Receiver.svelte onMetaData null-guards the post-await key assignment');
}

console.log(
  'ok - receiver onMetaData: no uncaught TypeError when Remove lands in the key-decryption window'
);
