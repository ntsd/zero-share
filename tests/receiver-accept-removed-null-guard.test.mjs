// Regression guard for P1 "receiver onAccept writes to receivingFiles[id]
// without a null guard — uncaught TypeError when the entry is removed just
// before Accept runs (plaintext mode)".
//
// Receiver.svelte onAccept(id) is the only function in the file that performs
// an UNGUARDED WRITE to a potentially-missing receivingFiles[id] entry. It
// read `receivingFile = receivingFiles[id]` and null-safe-read it in its
// reject guard, but then wrote:
//
//     receivingFiles[id].status = FileStatus.Processing;
//     receivingFiles[id].startTime = Date.now();
//
// with no existence guard. The reachable trigger is the Accept button in
// ReceivingFileList.svelte: onAccept(key) runs synchronously with no
// top-level await, so an entry deleted just before the click's task — by
// onChannelClose / onRemove / onDeny from a separate task in the window
// between the rendered button and Svelte re-rendering it away — leaves
// receivingFiles[id] undefined.
//
// Mode-dependent (why it was subtle): with isEncrypt === false (plaintext),
// the reject guard's `(isEncrypt && !receivingFile?.aesKey)` term is false,
// so the early-return does NOT fire and execution falls through to the
// unguarded write, throwing
//   TypeError: Cannot set properties of undefined (setting 'status')
// from the click handler — no toast, no cleanup, and the half-fired
// EVENT_RECEIVER_ACCEPT already advanced the sender to Processing while the
// receiver crashed before initializing its chunk map. In encrypted mode the
// `!receivingFile?.aesKey` term made the guard fire, masking the gap.
//
// The fix adds a top-level null guard in onAccept (bail before the
// EVENT_RECEIVER_ACCEPT send and before any state write — a removed entry
// must not advance the sender) and writes through the captured reference.
// This test drives the pre-fix shape (proving the mock reproduces the
// plaintext-mode crash) and the post-fix shape (proving no exception escapes,
// no accept signal and no state write happen for a removed entry, and a
// live entry still gets accepted end to end), plus a static guard on the
// real component. Mirrors the style of
// tests/receiver-remove-download-null-guard.test.mjs and
// tests/receiver-metadata-key-null-guard.test.mjs.
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

function makeState() {
  return {
    receivingFiles: {},
    receivingFileChunkMap: {},
    receivingFileStatsMap: {},
    chunkQueue: {}
  };
}

function makeEntry(name = 'a.bin', size = 300) {
  return {
    metaData: { name, size, type: 'application/octet-stream' },
    progress: 0,
    bitrate: 0,
    startTime: 0,
    status: FileStatus.WaitingAccept
  };
}

// ---- Test 1 (onAccept): PRE-FIX control — the unguarded write throws ------
// Plaintext mode (isEncrypt = false), entry deleted between render and click.
// The reject guard's optional-chained reads stay falsy, so execution falls
// through to `receivingFiles[id].status = ...` on a missing entry. Proves the
// mock reproduces the original bug.
{
  const ID = 'file-1';
  const state = makeState();
  state.receivingFiles[ID] = makeEntry();
  const sends = [];
  function send(event) {
    sends.push(event);
  }

  // PRE-FIX shape: optional-chained reads in the reject guard, unguarded map
  // re-reads for the status/startTime writes (the original crash site).
  function onAccept(id) {
    const receivingFile = state.receivingFiles[id];
    if (receivingFile?.error || (false && !receivingFile?.aesKey)) {
      send('EVENT_RECEIVER_REJECT');
      return;
    }
    send('EVENT_RECEIVER_ACCEPT');
    state.receivingFiles[id].status = FileStatus.Processing; // crash site
    state.receivingFiles[id].startTime = Date.now();
    state.receivingFileChunkMap[id] = { receivedChunks: [] };
    state.receivingFileStatsMap[id] = {
      progress: 0,
      startTime: 0,
      nextProgressUpdate: 0,
      receivedSize: 0
    };
    delete state.chunkQueue[id];
  }

  delete state.receivingFiles[ID]; // onRemove/onDeny/onChannelClose raced the click

  assert.throws(
    () => onAccept(ID),
    (err) => {
      assert.ok(err instanceof TypeError, 'must be a TypeError, got ' + err.constructor.name);
      assert.match(String(err), /Cannot set properties of undefined \(setting 'status'\)/);
      return true;
    },
    'pre-fix onAccept must throw TypeError when the entry was removed before the click'
  );
  // The damage the report calls out: the accept event already went out and
  // the crash landed BEFORE the chunk maps were initialized.
  assert.deepEqual(
    sends,
    ['EVENT_RECEIVER_ACCEPT'],
    'the half-fired accept already advanced the sender'
  );
  assert.equal(
    state.receivingFileChunkMap[ID],
    undefined,
    'the crash skipped the chunk-map initialization (inconsistent state)'
  );
  assert.equal(state.receivingFiles[ID], undefined, 'the entry stays removed');
  await delay(10);
  console.log(
    'ok - control: pre-fix onAccept throws uncaught TypeError on a removed entry (plaintext)'
  );
}

// ---- Test 2 (onAccept): POST-FIX — removed entry is a silent no-op ---------
// No throw, no accept signal (the sender must not advance), no status write,
// no chunk-map creation for the missing entry.
{
  const ID = 'file-2';
  const state = makeState();
  state.receivingFiles[ID] = makeEntry();
  const sends = [];
  function send(event) {
    sends.push(event);
  }

  // POST-FIX shape: top-level null guard, writes through the captured ref.
  function onAccept(id) {
    const receivingFile = state.receivingFiles[id];
    if (!receivingFile) return;
    if (receivingFile.error || (false && !receivingFile.aesKey)) {
      send('EVENT_RECEIVER_REJECT');
      return;
    }
    send('EVENT_RECEIVER_ACCEPT');
    receivingFile.status = FileStatus.Processing;
    receivingFile.startTime = Date.now();
    state.receivingFileChunkMap[id] = { receivedChunks: [] };
    state.receivingFileStatsMap[id] = {
      progress: 0,
      startTime: 0,
      nextProgressUpdate: 0,
      receivedSize: 0
    };
    delete state.chunkQueue[id];
  }

  delete state.receivingFiles[ID]; // removal raced the click
  assert.doesNotThrow(() => onAccept(ID), 'post-fix onAccept must not throw on a removed entry');
  assert.deepEqual(sends, [], 'no accept/reject event may fire for a removed entry');
  assert.equal(state.receivingFiles[ID], undefined, 'the entry stays removed');
  assert.equal(
    state.receivingFileChunkMap[ID],
    undefined,
    'no chunk map must be created for a removed entry'
  );
  assert.equal(
    state.receivingFileStatsMap[ID],
    undefined,
    'no stats map must be created for a removed entry'
  );
  await delay(10);
  console.log(
    'ok - post-fix onAccept is a safe no-op on a removed entry (no throw, no accept sent)'
  );
}

// ---- Test 3 (onAccept): POST-FIX — live entry still accepted end to end ----
// No behavior regression: a present, valid WaitingAccept entry is accepted,
// advances to Processing with a fresh startTime, and its chunk maps are
// initialized so subsequent onChunkData flows into processChunk.
{
  const ID = 'file-3';
  const state = makeState();
  state.receivingFiles[ID] = makeEntry();
  const sends = [];
  function send(event) {
    sends.push(event);
  }

  function onAccept(id) {
    const receivingFile = state.receivingFiles[id];
    if (!receivingFile) return;
    if (receivingFile.error || (false && !receivingFile.aesKey)) {
      send('EVENT_RECEIVER_REJECT');
      return;
    }
    send('EVENT_RECEIVER_ACCEPT');
    receivingFile.status = FileStatus.Processing;
    receivingFile.startTime = Date.now();
    state.receivingFileChunkMap[id] = { receivedChunks: [] };
    state.receivingFileStatsMap[id] = {
      progress: 0,
      startTime: 0,
      nextProgressUpdate: 0,
      receivedSize: 0
    };
    delete state.chunkQueue[id];
  }

  const before = Date.now();
  onAccept(ID);

  assert.deepEqual(sends, ['EVENT_RECEIVER_ACCEPT'], 'a live entry must still signal ACCEPT');
  assert.equal(
    state.receivingFiles[ID].status,
    FileStatus.Processing,
    'the entry must advance to Processing'
  );
  assert.ok(
    state.receivingFiles[ID].startTime >= before && state.receivingFiles[ID].startTime > 0,
    'startTime must be set to "now" (not the placeholder 0)'
  );
  assert.ok(
    Array.isArray(state.receivingFileChunkMap[ID].receivedChunks),
    'the chunk map must be initialized so chunk flow can proceed'
  );
  assert.equal(state.receivingFileStatsMap[ID].receivedSize, 0);
  // onChunkData for this file now finds a live entry + chunk map (it would
  // have dropped silently had onAccept been a no-op, stalling the transfer).
  assert.ok(state.receivingFiles[ID] && state.receivingFileChunkMap[ID]);
  await delay(10);
  console.log('ok - post-fix onAccept still accepts a live entry and initializes the chunk maps');
}

// ---- Test 4: static guard — the real component carries the guards ---------
{
  const receiverSource = readFileSync(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );

  // Scope the checks to the onAccept body (the file legitimately carries other
  // guarded `receivingFiles[id].status` writes, e.g. the Success assignment in
  // processChunk behind its chunk-map guard).
  const onAcceptBody = receiverSource.slice(
    receiverSource.indexOf('function onAccept'),
    receiverSource.indexOf('function onDeny')
  );
  assert.ok(onAcceptBody.length > 0, 'onAccept must exist in Receiver.svelte');

  // The original crash site — unguarded map re-reads for the writes — must be
  // gone from onAccept.
  assert.ok(
    !/receivingFiles\[id\]\.status\s*=/.test(onAcceptBody),
    'onAccept must not assign status via an unguarded receivingFiles[id] re-read'
  );
  assert.ok(
    !/receivingFiles\[id\]\.startTime\s*=/.test(onAcceptBody),
    'onAccept must not assign startTime via an unguarded receivingFiles[id] re-read'
  );

  // The post-fix shape: onAccept captures the entry and bails on a missing
  // one before anything else (the reject guard and the accept send included).
  // The guard may be the standalone null check or the combined
  // null+status guard (`!receivingFile || status !== WaitingAccept`) added
  // for the double-click re-entrancy race — both null-guard the entry first.
  assert.ok(
    /function\s+onAccept\s*\(\s*id:\s*string\s*\)\s*\{\s*const\s+receivingFile\s*=\s*receivingFiles\[id\];[\s\S]*?if\s*\(\s*!receivingFile\s*(?:\|\|\s*receivingFile\.status\s*!==\s*FileStatus\.WaitingAccept)?\s*\)\s*(?:\{\s*return;?\s*\}|return;)/.test(
      onAcceptBody
    ),
    'onAccept must capture receivingFiles[id] and null-guard it (optionally with a status guard) before the reject guard / accept send / state writes'
  );

  // The writes go through the captured reference, not a bare map re-read.
  assert.ok(
    /receivingFile\.status\s*=\s*FileStatus\.Processing;/.test(onAcceptBody),
    'onAccept must write status through the captured receivingFile'
  );
  assert.ok(
    /receivingFile\.startTime\s*=\s*Date\.now\(\);/.test(onAcceptBody),
    'onAccept must write startTime through the captured receivingFile'
  );

  // The reject guard must still fire for failed-metadata entries (the guard
  // must not have swallowed that path).
  assert.ok(
    /if\s*\(\s*receivingFile\.error\s*\|\|\s*\(\s*isEncrypt\s*&&\s*!\s*receivingFile\.aesKey\s*\)\s*\)/.test(
      onAcceptBody
    ),
    'onAccept must still reject entries whose metadata/key failed to process'
  );

  // The chunk-map initialization must survive (the auto-accept path still
  // reaches it for live entries).
  assert.ok(
    /receivingFileChunkMap\[id\]\s*=\s*\{\s*receivedChunks:\s*\[\]\s*\};/.test(onAcceptBody),
    'onAccept must still initialize the per-file chunk map'
  );

  console.log(
    'ok - static: Receiver.svelte onAccept null-guards the entry and the status/startTime writes'
  );
}

console.log(
  'ok - receiver onAccept: no uncaught TypeError, no accept sent, no state write when the entry is removed before the click'
);
