// Regression guard for P1 "receiver onAccept() has no status/re-entrancy
// guard — a double Accept click re-sends EVENT_RECEIVER_ACCEPT and
// re-initializes the chunk map, dead-ending the transfer".
//
// Receiver.svelte onAccept(id) previously null-guarded the entry but never
// checked receivingFile.status. It is safe to call only while the entry is
// in FileStatus.WaitingAccept. Two reachable trigger paths:
//
//  1. UI double-click: manual-accept mode, two Accept clicks land in the same
//     frame before Svelte re-renders the button away (onAccept flips the
//     entry to Processing only after the ACCEPT send). Both calls send
//     EVENT_RECEIVER_ACCEPT and both re-create receivingFileChunkMap[id] /
//     receivingFileStatsMap[id] and delete chunkQueue[id]. On the sender,
//     the ACCEPT handler is registered with eventemitter3's persistent .on()
//     (not .once), so two ACCEPT messages fire sendNextChunk() concurrently,
//     both slicing at the same closure offset — the same chunk goes on the
//     wire twice, receivedSize is double-counted, and the exact-match gate
//     is either never reached or crossed into rejectOversizedStream: a
//     fully-sent file rejected as "stream exceeded the declared size".
//
//  2. Dead-channel click: after onChannelClose() every non-Success entry is
//     bounced to Pending + error. An Accept click on such an entry (the
//     button is still rendered when the channel dies) passed the null guard,
//     sent a no-op ACCEPT, and re-initialized chunk state for a file that can
//     never complete — the entry flipped to Processing with no chunks ever
//     arriving.
//
// The fix adds a status guard alongside the null guard:
//
//     if (!receivingFile || receivingFile.status !== FileStatus.WaitingAccept) {
//       return;
//     }
//
// The guard must NOT short-circuit the metadata-failure reject branch: a
// WaitingAccept entry carrying error / a missing aesKey still reaches the
// "Cannot accept … the metadata/key failed to process" path (it intentionally
// rejects so the sender bounces to Pending).
//
// This test drives the pre-fix shape (proving the mock reproduces the
// double-accept), the post-fix shape (no second ACCEPT send, no state
// re-initialization on a re-entrant or dead-channel click, and a
// metadata-failure entry in WaitingAccept still rejects), plus a static
// guard on the real component. Mirrors the style of
// tests/receiver-accept-removed-null-guard.test.mjs.
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

// ---- Test 1 (onAccept): PRE-FIX control — double click sends two ACCEPTs --
// Plaintext mode (isEncrypt = false). Two onAccept calls land in the same
// frame: the first flips the entry to Processing, but the second call
// re-reads the live entry, passes the null guard, and fires a second
// EVENT_RECEIVER_ACCEPT — re-initializing the chunk map. The sender's
// persistent ACCEPT handler then fires sendNextChunk() concurrently and the
// same chunk goes on the wire twice.
{
  const ID = 'file-1';
  const state = makeState();
  state.receivingFiles[ID] = makeEntry();
  const sends = [];
  function send(event) {
    sends.push(event);
  }

  // PRE-FIX shape: null guard only, no status check (the original race).
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

  // Two clicks land in the same frame: the second call re-reads the live
  // entry (now Processing) and re-accepts it.
  onAccept(ID);
  onAccept(ID);

  assert.deepEqual(
    sends,
    ['EVENT_RECEIVER_ACCEPT', 'EVENT_RECEIVER_ACCEPT'],
    'pre-fix double click must send EVENT_RECEIVER_ACCEPT twice'
  );
  assert.equal(
    state.receivingFileStatsMap[ID].receivedSize,
    0,
    'the second accept re-initialized the stats map (receivedSize reset to 0)'
  );
  await delay(10);
  console.log('ok - control: pre-fix onAccept double click sends two EVENT_RECEIVER_ACCEPT');
}

// ---- Test 2 (onAccept): POST-FIX — re-entrant click is a no-op ------------
// Same-frame double click: the first call accepts and flips to Processing;
// the second call must bail on the status guard before the ACCEPT send and
// before any state write. Exactly one ACCEPT reaches the wire.
{
  const ID = 'file-2';
  const state = makeState();
  state.receivingFiles[ID] = makeEntry();
  const sends = [];
  function send(event) {
    sends.push(event);
  }

  // POST-FIX shape: combined null + status guard.
  function onAccept(id) {
    const receivingFile = state.receivingFiles[id];
    if (!receivingFile || receivingFile.status !== FileStatus.WaitingAccept) {
      return;
    }
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

  onAccept(ID);
  onAccept(ID);

  assert.deepEqual(sends, ['EVENT_RECEIVER_ACCEPT'], 'exactly one ACCEPT may reach the wire');
  assert.equal(
    state.receivingFiles[ID].status,
    FileStatus.Processing,
    'the entry stays in Processing after the re-entrant click'
  );
  // The second click must not have re-initialized the chunk map: simulate a
  // chunk that arrived in between — its receivedSize must survive.
  state.receivingFileStatsMap[ID].receivedSize = 150;
  const chunkMapRef = state.receivingFileChunkMap[ID];
  onAccept(ID); // a third click must also be a no-op
  assert.equal(
    state.receivingFileStatsMap[ID].receivedSize,
    150,
    'the re-entrant click must not re-initialize the stats map'
  );
  assert.equal(state.receivingFileChunkMap[ID], chunkMapRef, 'the chunk map is not recreated');
  assert.deepEqual(sends, ['EVENT_RECEIVER_ACCEPT'], 'no further ACCEPT after the first');
  await delay(10);
  console.log('ok - post-fix onAccept double click sends exactly one EVENT_RECEIVER_ACCEPT');
}

// ---- Test 3 (onAccept): POST-FIX — dead-channel (Pending) click is a no-op -
// onChannelClose() bounced the entry to Pending + error; the Accept button
// is still rendered. A click must bail before the ACCEPT send and before the
// chunk-state re-initialization — the entry cannot complete anyway.
{
  const ID = 'file-3';
  const state = makeState();
  state.receivingFiles[ID] = makeEntry();
  const entry = state.receivingFiles[ID];
  // onChannelClose() effect: non-Success entries bounce to Pending + error.
  entry.error = new Error('Connection lost — transfer aborted');
  entry.status = FileStatus.Pending;
  const sends = [];
  function send(event) {
    sends.push(event);
  }

  function onAccept(id) {
    const receivingFile = state.receivingFiles[id];
    if (!receivingFile || receivingFile.status !== FileStatus.WaitingAccept) {
      return;
    }
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

  assert.doesNotThrow(() => onAccept(ID), 'post-fix click on a dead-channel entry must not throw');
  assert.deepEqual(sends, [], 'no ACCEPT may be sent for a Pending (connection-lost) entry');
  assert.equal(
    state.receivingFileChunkMap[ID],
    undefined,
    'no chunk state may be re-initialized for a file that can never complete'
  );
  assert.equal(
    state.receivingFileStatsMap[ID],
    undefined,
    'no stats state may be re-initialized for a file that can never complete'
  );
  assert.equal(entry.status, FileStatus.Pending, 'the entry must not flip to Processing');
  await delay(10);
  console.log('ok - post-fix onAccept is a no-op on a dead-channel (Pending) entry');
}

// ---- Test 4 (onAccept): POST-FIX — metadata-failure branch is not blocked --
// A WaitingAccept entry that carries error (or a missing aesKey on an
// encrypted session) must STILL reach the reject branch: the status guard
// must not short-circuit it. The reject is intentional so the sender bounces
// to Pending.
{
  const ID = 'file-4';
  const state = makeState();
  state.receivingFiles[ID] = makeEntry();
  state.receivingFiles[ID].error = new Error('Failed to decrypt the file key');
  const sends = [];
  const toasts = [];
  function send(event) {
    sends.push(event);
  }
  function addToastMessage(message, kind) {
    toasts.push({ message, kind });
  }

  function onAccept(id) {
    const receivingFile = state.receivingFiles[id];
    if (!receivingFile || receivingFile.status !== FileStatus.WaitingAccept) {
      return;
    }
    if (receivingFile.error || (false && !receivingFile.aesKey)) {
      addToastMessage(
        `Cannot accept ${receivingFile?.metaData.name ?? id}: the metadata/key failed to process — the sender must resend the file`,
        'error'
      );
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

  onAccept(ID);

  assert.deepEqual(sends, ['EVENT_RECEIVER_REJECT'], 'the metadata-failure entry must reject');
  assert.equal(toasts.length, 1, 'the metadata-failure toast must fire');
  assert.match(
    toasts[0].message,
    /Cannot accept .* the metadata\/key failed to process/,
    'the toast must carry the metadata/key-failed message'
  );
  assert.equal(
    state.receivingFiles[ID].status,
    FileStatus.WaitingAccept,
    'the entry must stay in WaitingAccept (Deny/Remove remain available)'
  );
  await delay(10);
  console.log('ok - post-fix onAccept still rejects a WaitingAccept entry whose metadata failed');
}

// ---- Test 5: static guard — the real component carries the status guard ----
{
  const receiverSource = readFileSync(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );

  // Scope the checks to the onAccept body.
  const onAcceptBody = receiverSource.slice(
    receiverSource.indexOf('function onAccept'),
    receiverSource.indexOf('function onDeny')
  );
  assert.ok(onAcceptBody.length > 0, 'onAccept must exist in Receiver.svelte');

  // The guard: the combined null + status check, with the early return,
  // placed before the metadata-failure reject branch and the ACCEPT send.
  assert.ok(
    /if\s*\(\s*!receivingFile\s*\|\|\s*receivingFile\.status\s*!==\s*FileStatus\.WaitingAccept\s*\)\s*\{\s*return;?\s*\}/.test(
      onAcceptBody
    ),
    'onAccept must guard on receivingFile.status === FileStatus.WaitingAccept (bail otherwise)'
  );

  // The guard must sit between the entry capture and the metadata-failure
  // reject branch: capture -> guard -> reject branch -> ACCEPT send ->
  // status write.
  const captureIdx = onAcceptBody.indexOf('const receivingFile = receivingFiles[id];');
  const guardIdx = onAcceptBody.indexOf('receivingFile.status !== FileStatus.WaitingAccept');
  const rejectBranchIdx = onAcceptBody.indexOf('receivingFile.error || (isEncrypt');
  // The real send call site (the onAccept body comment mentions
  // EVENT_RECEIVER_ACCEPT too — scope the match to the message field so the
  // ordering check lands on the actual send, not the comment).
  const acceptSendIdx = onAcceptBody.indexOf('receiveEvent: ReceiveEvent.EVENT_RECEIVER_ACCEPT');
  assert.ok(captureIdx !== -1, 'onAccept must capture receivingFiles[id]');
  assert.ok(guardIdx > captureIdx, 'the status guard must come after the entry capture');
  assert.ok(
    guardIdx > -1 && rejectBranchIdx > guardIdx,
    'the status guard must come before the metadata-failure reject branch (so that branch stays reachable)'
  );
  assert.ok(
    rejectBranchIdx > -1 && acceptSendIdx > rejectBranchIdx,
    'the metadata-failure reject branch must come before the ACCEPT send'
  );

  // The reject branch must still be intact (the guard must not have swallowed
  // it) — it intentionally rejects so the sender bounces to Pending.
  assert.ok(
    /if\s*\(\s*receivingFile\.error\s*\|\|\s*\(\s*isEncrypt\s*&&\s*!\s*receivingFile\.aesKey\s*\)\s*\)/.test(
      onAcceptBody
    ),
    'onAccept must still reject entries whose metadata/key failed to process'
  );

  console.log(
    'ok - static: Receiver.svelte onAccept checks FileStatus.WaitingAccept before ACCEPT'
  );
}

console.log(
  'ok - receiver onAccept: no double ACCEPT, no chunk-state re-initialization, metadata-failure branch intact'
);
