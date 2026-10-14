// Regression guard for the dedup of the two identical chunk-failure catch
// blocks in Sender.svelte#onSend (Ponytail rung 2 / DRY).
//
// Before the fix, the EVENT_RECEIVER_ACCEPT and EVENT_RECEIVED_CHUNK
// handlers each inlined the exact same bookkeeping for a failed
// sendNextChunk(): message coercion, live entry re-read,
// `status !== Success && !stop` guard, `error = new Error(
// 'Failed to send chunk: ...')`, `status = Pending`, and the error toast.
// The two blocks were kept in lockstep by hand — any change to
// chunk-failure handling had to be applied in two places.
//
// The fix extracts one shared helper inside onSend, `markChunkFailed(err)`,
// closing over `key` and `sendingFile.metaData.name`, called from both
// catch blocks. This test:
//   1. statically asserts the dedup: exactly one helper, exactly two call
//      sites, no inlined duplicate bookkeeping, #46/#45 provenance kept;
//   2. dynamically mirrors both handlers + the helper (driven through a
//      real eventemitter3, like tests/receiver-chunk-order.test.mjs) with a
//      failing sendNextChunk(), and asserts BOTH paths yield
//      status === Pending, error.message === 'Failed to send chunk: ...',
//      and exactly one error toast.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import EventEmitter from 'eventemitter3';

const here = dirname(fileURLToPath(import.meta.url));
const senderSource = readFileSync(
  join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
  'utf8'
);

// FileStatus values, mirrored from src/type.ts (Svelte/TS not importable here).
const FileStatus = {
  Pending: 'Pending',
  WaitingAccept: 'WaitingAccept',
  Processing: 'Processing',
  Success: 'Success'
};

// ---- Test 1 (static): the dedup — one shared helper, two call sites --------
{
  // The shared helper exists, closing over err: unknown.
  assert.ok(
    /function\s+markChunkFailed\s*\(\s*err:\s*unknown\s*\)\s*\{/.test(senderSource),
    'onSend must define the shared markChunkFailed(err: unknown) helper'
  );

  // Exactly ONE copy of the bookkeeping: the `Failed to send chunk` error
  // construction must live only inside the helper, not inlined in a handler.
  const bookkeepingSites =
    senderSource.match(/new Error\(\s*`Failed to send chunk: \$\{message\}`\s*\)/g) || [];
  assert.equal(
    bookkeepingSites.length,
    1,
    'the "Failed to send chunk" error must be constructed exactly once (in the shared helper), found ' +
      bookkeepingSites.length +
      ' site(s)'
  );

  // Both catch blocks delegate to the helper — one-liner catch bodies, exactly two of them.
  const catchDelegates =
    senderSource.match(/catch\s*\(\s*err\s*\)\s*\{\s*markChunkFailed\(err\);\s*\}/g) || [];
  assert.equal(
    catchDelegates.length,
    2,
    'both the ACCEPT and RECEIVED_CHUNK catch blocks must delegate to markChunkFailed(err), found ' +
      catchDelegates.length
  );

  // The provenance comment (#46/#45) is preserved on the shared helper.
  const helperIdx = senderSource.search(/function\s+markChunkFailed\s*\(/);
  const helperCommentWindow = senderSource.slice(Math.max(0, helperIdx - 400), helperIdx);
  assert.ok(
    /#46\/#45/.test(helperCommentWindow),
    'the #46/#45 provenance comment must be preserved on the shared helper'
  );
  console.log('ok - static: chunk-failure bookkeeping deduped into one markChunkFailed helper');
}

// ---- Test 2 (dynamic): a failed sendNextChunk() in BOTH event paths --------
// Mirrors the two handler bodies from Sender.svelte#onSend (post-dedup shape),
// driven through a real EventEmitter with a sendNextChunk() that rejects.
function registerHandlers(sendingFiles, key, sendingFile, toasts, sendNextChunk) {
  // Shared bookkeeping (mirror of the Sender.svelte helper, verbatim logic).
  function markChunkFailed(err) {
    const message = err instanceof Error ? err.message : String(err);
    const entry = sendingFiles[key];
    if (entry && entry.status !== FileStatus.Success && !entry.stop) {
      entry.error = new Error(`Failed to send chunk: ${message}`);
      entry.status = FileStatus.Pending;
      toasts.push(`File ${sendingFile.metaData.name} failed to send: ${message}`);
    }
  }

  const event = new EventEmitter();
  // Mirrors the EVENT_RECEIVER_ACCEPT handler.
  event.on('EVENT_RECEIVER_ACCEPT', async () => {
    const f = sendingFiles[key];
    if (!f) return;
    f.status = FileStatus.Processing;
    f.startTime = Date.now();
    try {
      await sendNextChunk();
    } catch (err) {
      markChunkFailed(err);
    }
  });
  // Mirrors the EVENT_RECEIVED_CHUNK handler (chunk branch only).
  event.on('EVENT_RECEIVED_CHUNK', async () => {
    const f = sendingFiles[key];
    if (!f) return;
    if (f.stop) return;
    if (f.error || f.status != FileStatus.Processing) {
      f.progress = 0;
      f.status = FileStatus.Pending;
      f.stop = false;
      return;
    }
    try {
      await sendNextChunk();
    } catch (err) {
      markChunkFailed(err);
    }
  });
  return { event, markChunkFailed };
}

function makeEntry(name, status) {
  return {
    metaData: { name, size: 300, type: 'application/octet-stream', key: new Uint8Array() },
    progress: 0,
    bitrate: 0,
    stop: false,
    error: undefined,
    startTime: Date.now(),
    status,
    aesKey: 'mock-aes-key',
    file: { name }
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CHUNK_FAIL = new Error('data channel closed');

// 2a: ACCEPT path.
{
  const key = 'file-accept';
  const sendingFiles = {};
  const sendingFile = makeEntry('a.bin', FileStatus.WaitingAccept);
  sendingFiles[key] = sendingFile;
  const toasts = [];
  const { event } = registerHandlers(sendingFiles, key, sendingFile, toasts, async () => {
    throw CHUNK_FAIL;
  });

  event.emit('EVENT_RECEIVER_ACCEPT');
  await delay(10); // let the async handler's catch settle

  const entry = sendingFiles[key];
  assert.equal(entry.status, FileStatus.Pending, 'ACCEPT path: status must bounce to Pending');
  assert.ok(entry.error instanceof Error, 'ACCEPT path: entry.error must be set');
  assert.equal(
    entry.error.message,
    'Failed to send chunk: data channel closed',
    'ACCEPT path: error message must be "Failed to send chunk: ..."'
  );
  assert.deepEqual(
    toasts,
    ['File a.bin failed to send: data channel closed'],
    'ACCEPT path: exactly one error toast with the expected text'
  );
  console.log('ok - dynamic: ACCEPT path chunk failure bounces to Pending with error + toast');
}

// 2b: RECEIVED_CHUNK path.
{
  const key = 'file-chunk';
  const sendingFiles = {};
  const sendingFile = makeEntry('b.bin', FileStatus.Processing);
  sendingFiles[key] = sendingFile;
  const toasts = [];
  const { event } = registerHandlers(sendingFiles, key, sendingFile, toasts, async () => {
    throw CHUNK_FAIL;
  });

  event.emit('EVENT_RECEIVED_CHUNK');
  await delay(10);

  const entry = sendingFiles[key];
  assert.equal(
    entry.status,
    FileStatus.Pending,
    'RECEIVED_CHUNK path: status must bounce to Pending'
  );
  assert.ok(entry.error instanceof Error, 'RECEIVED_CHUNK path: entry.error must be set');
  assert.equal(
    entry.error.message,
    'Failed to send chunk: data channel closed',
    'RECEIVED_CHUNK path: error message must be "Failed to send chunk: ..."'
  );
  assert.deepEqual(
    toasts,
    ['File b.bin failed to send: data channel closed'],
    'RECEIVED_CHUNK path: exactly one error toast with the expected text'
  );
  console.log(
    'ok - dynamic: RECEIVED_CHUNK path chunk failure bounces to Pending with error + toast'
  );
}

// 2c: non-Error rejection is coerced with String(err) in the shared helper.
{
  const key = 'file-str';
  const sendingFiles = {};
  const sendingFile = makeEntry('c.bin', FileStatus.Processing);
  sendingFiles[key] = sendingFile;
  const toasts = [];
  const { event } = registerHandlers(sendingFiles, key, sendingFile, toasts, async () => {
    throw 'boom-string';
  });

  event.emit('EVENT_RECEIVED_CHUNK');
  await delay(10);

  const entry = sendingFiles[key];
  assert.equal(entry.status, FileStatus.Pending);
  assert.equal(entry.error.message, 'Failed to send chunk: boom-string');
  assert.deepEqual(toasts, ['File c.bin failed to send: boom-string']);
  console.log('ok - dynamic: non-Error rejection is coerced via String(err)');
}

// 2d: the helper's own guard — a completed (Success) entry is never touched,
// and neither is a stopped one (no status change, no error, no toast). The
// event handlers' pre-checks short-circuit on their own before reaching the
// helper for these states, so drive the shared helper directly here — this is
// exactly the bookkeeping both catch blocks delegate to.
{
  for (const [label, status, stop] of [
    ['Success entry', FileStatus.Success, false],
    ['stopped entry', FileStatus.Processing, true]
  ]) {
    const key = `file-guard-${label}`;
    const sendingFiles = {};
    const sendingFile = makeEntry('d.bin', status);
    sendingFile.stop = stop;
    sendingFiles[key] = sendingFile;
    const toasts = [];
    const { markChunkFailed } = registerHandlers(
      sendingFiles,
      key,
      sendingFile,
      toasts,
      async () => {
        throw CHUNK_FAIL;
      }
    );
    markChunkFailed(CHUNK_FAIL);
    const entry = sendingFiles[key];
    assert.equal(entry.status, status, `${label}: status must be left untouched (${status})`);
    assert.equal(entry.error, undefined, `${label}: no error may be set`);
    assert.equal(toasts.length, 0, `${label}: no toast may fire`);
  }
  console.log('ok - dynamic: Success / stopped entries are exempt from the shared helper');
}

console.log('ok - sender chunk failure: both event paths share one markChunkFailed helper');
