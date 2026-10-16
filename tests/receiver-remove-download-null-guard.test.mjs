// Regression guard for P0 "receiver onRemove/onDownload dereference
// receivingFiles[key] with no null guard — unhandled TypeError and skipped
// teardown on a missing/duplicated entry".
//
// Receiver.svelte exposed two user-click handlers that re-read the live file
// map and immediately dereferenced it with NO existence guard:
//   - onRemove(key):  `if (receivingFiles[key].status != FileStatus.Success)`
//     — throws `TypeError: Cannot read properties of undefined (reading
//     'status')` when receivingFiles[key] is undefined, and the local teardown
//     (delete receivingFileChunkMap/receivingFileStatsMap/chunkQueue/
//     receivingFiles[key]) below the guard never runs.
//   - onDownload(key): `receivedFile.blob` — throws when receivedFile is
//     undefined.
//
// Both are bound directly to buttons in ReceivingFileList.svelte, so the
// reachable window is a key that is absent at call time: a duplicate /
// double-fired click, or an entry torn down by a concurrent path (e.g.
// onChannelClose or a second onRemove) between the render that produced the
// button and the click. The rest of the codebase already treats this exact
// race as first-class: the SENDER's onRemove/onSend/onContinue guard it
// (`const f = sendingFiles[key]; if (!f) return;`), and the RECEIVER's own
// onChunkData guards the same shape (`const receivingFile = receivingFiles[id];
// if (!receivingFile || ...) return;`). These two click handlers were the only
// file-map reads in Receiver.svelte that skipped the guard.
//
// The fix mirrors the sender's pattern: onRemove captures `f = receivingFiles[key]`
// and bails on `!f`; onDownload bails on `!receivedFile`. This test drives the
// pre-fix shape (proving the mock reproduces the raw TypeError) and the
// post-fix shape (proving no exception escapes and teardown still happens),
// plus a static guard that the real component carries the guard.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// FileStatus values, mirrored from src/type.ts (Svelte/TS not importable here).
const FileStatus = {
  Pending: 'Pending',
  WaitingAccept: 'WaitingAccept',
  Processing: 'Processing',
  Success: 'Success'
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeState() {
  return {
    receivingFiles: {},
    receivingFileChunkMap: {},
    receivingFileStatsMap: {},
    chunkQueue: {}
  };
}

// ---- Test 1 (onRemove): PRE-FIX control — the unguarded deref throws --------
// The first onRemove deletes the entry (as real teardown does); a second,
// duplicate click then hits an empty map and throws on `.status`, skipping the
// teardown block. Proves the mock reproduces the original bug.
{
  const ID = 'file-1';
  const state = makeState();
  state.receivingFiles[ID] = {
    metaData: { name: 'a.bin', size: 300, type: 'application/octet-stream' },
    status: FileStatus.Processing
  };
  state.receivingFileChunkMap[ID] = { receivedChunks: [] };
  state.receivingFileStatsMap[ID] = { progress: 0, receivedSize: 0 };
  state.chunkQueue[ID] = {};

  const rejects = [];
  function send(event) {
    rejects.push(event);
  }

  // PRE-FIX shape: dereferences receivingFiles[key] with no existence guard.
  function onRemove(key) {
    if (state.receivingFiles[key].status != FileStatus.Success) {
      send('EVENT_RECEIVER_REJECT');
    }
    delete state.receivingFileChunkMap[key];
    delete state.receivingFileStatsMap[key];
    delete state.chunkQueue[key];
    delete state.receivingFiles[key];
  }

  onRemove(ID); // first click — legitimately removes the entry
  assert.equal(state.receivingFiles[ID], undefined, 'first onRemove must remove the entry');

  assert.throws(
    () => onRemove(ID), // duplicate click — entry already gone
    (err) => {
      assert.ok(err instanceof TypeError, 'must be a TypeError, got ' + err.constructor.name);
      assert.match(String(err), /Cannot read properties of undefined \(reading 'status'\)/);
      return true;
    },
    'pre-fix onRemove must throw TypeError on a missing entry'
  );
  await delay(10);
  console.log('ok - control: pre-fix onRemove throws uncaught TypeError on a missing entry');
}

// ---- Test 2 (onRemove): POST-FIX — guarded; duplicate click is a safe no-op ----
{
  const ID = 'file-1';
  const state = makeState();
  state.receivingFiles[ID] = {
    metaData: { name: 'a.bin', size: 300, type: 'application/octet-stream' },
    status: FileStatus.Processing
  };
  state.receivingFileChunkMap[ID] = { receivedChunks: [] };
  state.receivingFileStatsMap[ID] = { progress: 0, receivedSize: 0 };
  state.chunkQueue[ID] = {};

  const rejects = [];
  function send(event) {
    rejects.push(event);
  }

  // POST-FIX shape: capture the entry and bail when it is gone.
  function onRemove(key) {
    const f = state.receivingFiles[key];
    if (!f) return;
    if (f.status != FileStatus.Success) {
      send('EVENT_RECEIVER_REJECT');
    }
    delete state.receivingFileChunkMap[key];
    delete state.receivingFileStatsMap[key];
    delete state.chunkQueue[key];
    delete state.receivingFiles[key];
  }

  onRemove(ID); // first click — removes the entry, sends one reject
  assert.equal(rejects.length, 1, 'a non-Success removal must send exactly one reject');
  assert.equal(
    state.receivingFileChunkMap[ID],
    undefined,
    'first onRemove must tear down the chunk map'
  );
  assert.equal(state.receivingFileStatsMap[ID], undefined);
  assert.equal(state.chunkQueue[ID], undefined);

  onRemove(ID); // duplicate click — must NOT throw
  assert.equal(rejects.length, 1, 'a duplicate onRemove must not send a second reject');
  assert.equal(state.receivingFiles[ID], undefined, 'the entry stays removed');
  await delay(10);
  console.log('ok - post-fix onRemove is a safe no-op on a duplicate/missing entry');
}

// ---- Test 3 (onDownload): PRE-FIX control — the unguarded `.blob` throws ----
{
  const ID = 'file-1';
  const state = makeState();
  state.receivingFiles[ID] = {
    metaData: { name: 'a.bin', size: 300, type: 'application/octet-stream' },
    status: FileStatus.Success,
    blob: new Blob(['hello'])
  };

  // PRE-FIX shape: dereferences receivedFile.blob with no existence guard.
  function onDownload(key) {
    const receivedFile = state.receivingFiles[key];
    const blobFile = receivedFile.blob; // throws if receivedFile is undefined
    if (!blobFile) {
      return;
    }
  }

  assert.throws(
    () => onDownload('ghost'), // a key that was never added / already removed
    (err) => {
      assert.ok(err instanceof TypeError, 'must be a TypeError, got ' + err.constructor.name);
      assert.match(String(err), /Cannot read properties of undefined \(reading 'blob'\)/);
      return true;
    },
    'pre-fix onDownload must throw TypeError on a missing entry'
  );
  await delay(10);
  console.log('ok - control: pre-fix onDownload throws uncaught TypeError on a missing entry');
}

// ---- Test 4 (onDownload): POST-FIX — guarded; missing entry is a safe no-op ----
{
  const ID = 'file-1';
  const state = makeState();
  state.receivingFiles[ID] = {
    metaData: { name: 'a.bin', size: 300, type: 'application/octet-stream' },
    status: FileStatus.Success,
    blob: new Blob(['hello'])
  };

  let downloads = 0;

  // POST-FIX shape: bail when the entry is gone, otherwise proceed.
  function onDownload(key) {
    const receivedFile = state.receivingFiles[key];
    if (!receivedFile) return;
    const blobFile = receivedFile.blob;
    if (!blobFile) {
      return;
    }
    downloads++; // stand-in for triggerDownload(blobFile, receivedFile.metaData.name)
  }

  onDownload(ID); // present, has a blob — downloads
  assert.equal(downloads, 1, 'a present Success entry with a blob must download');

  onDownload('ghost'); // missing entry — must NOT throw
  assert.equal(downloads, 1, 'a missing onDownload entry must not download');

  delete state.receivingFiles[ID]; // entry removed between render and click
  onDownload(ID); // still safe
  assert.equal(downloads, 1, 'onDownload after removal must remain a no-op');
  await delay(10);
  console.log('ok - post-fix onDownload is a safe no-op on a missing/removed entry');
}

// ---- Test 5: static guard — the real component carries both guards ----------
{
  const receiverSource = readFileSync(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );

  // onRemove must capture the entry and bail before dereferencing `.status`.
  assert.ok(
    /function\s+onRemove\s*\(\s*key:\s*string\s*\)\s*\{[^}]*const\s+f\s*=\s*receivingFiles\[key\];\s*if\s*\(\s*!f\s*\)\s*return;/.test(
      receiverSource
    ),
    'onRemove must begin with `const f = receivingFiles[key]; if (!f) return;`'
  );
  // The status check must read the captured `f`, not a bare re-read of the map.
  assert.ok(
    /if\s*\(\s*f\.status\s*!=\s*FileStatus\.Success\s*\)/.test(receiverSource),
    'onRemove must check the captured f.status, not a bare receivingFiles[key].status'
  );
  // The unguarded first-line deref must be gone.
  assert.ok(
    !/if\s*\(\s*receivingFiles\[key\]\.status/.test(receiverSource),
    'onRemove must not dereference receivingFiles[key].status without a guard'
  );

  // onDownload must bail before reading `.blob` / `.metaData`.
  assert.ok(
    /function\s+onDownload\s*\(\s*key:\s*string\s*\)\s*\{\s*const\s+receivedFile\s*=\s*receivingFiles\[key\];\s*if\s*\(\s*!receivedFile\s*\)\s*return;/.test(
      receiverSource
    ),
    'onDownload must bail on `!receivedFile` before reading receivedFile.blob'
  );
  assert.ok(
    !/const\s+receivedFile\s*=\s*receivingFiles\[key\];\s*const\s+blobFile\s*=\s*receivedFile\.blob/.test(
      receiverSource
    ),
    'onDownload must not read receivedFile.blob without a guard'
  );

  console.log('ok - static: Receiver.svelte onRemove/onDownload carry the existence guards');
}

console.log(
  'ok - receiver onRemove/onDownload: no uncaught TypeError, no skipped teardown on a missing/duplicated entry'
);
