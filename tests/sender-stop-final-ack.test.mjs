// Regression guard for the stop-vs-final-ack race in Sender.svelte:
//
//   Stop clicked in the window between the final chunk hitting the wire and
//   the completion ack's bookkeeping.
//
// Before the fix, the EVENT_RECEIVED_CHUNK handler unconditionally bailed on
// `if (f.stop) return;`, and sendNextChunk() skipped its `offset +=`
// bookkeeping after the stop re-check. The net effect: every byte of the
// file was delivered and the receiver completed it (Success on its side),
// but the sender entry was stuck in `stop=true, status=Processing` with the
// closure's `offset` still one chunk behind the wire. The completion ack
// was dropped, so the entry never reached Success, and a later Continue
// re-sliced the last bytes and re-sent them — which the receiver's
// exact-size gate rejected as an overshoot (`rejectOversizedStream`),
// marking a fully delivered file as "Receiver reject the file".
//
// The fix (src/components/sender/Sender.svelte):
//   1. sendBuffer() returns `true` only when send() actually ran (wire
//      reality), `false` when it bailed on stop before sending.
//   2. sendNextChunk() advances `offset` whenever sendBuffer() reports a
//      wire send, so the closure's offset always matches the wire even when
//      stop flips mid-final-chunk.
//   3. The EVENT_RECEIVED_CHUNK handler no longer drops the completion ack
//      when stop is set but offset has already reached size (full delivery),
//      and it clears `stop` on completion so the list stops rendering a
//      spurious Continue button.
//   4. A terminal Success entry is never demoted by a stray / synthetic ack
//      (the bounce branch).
//
// This test drives the pipeline with a mock dataChannel + event wiring
// (same harness style as tests/sender-connection-lost.test.mjs and
// tests/sender-remove-inflight.test.mjs) and adds static source guards so
// the real component keeps the fix shape. The receiver's exact-size reject
// gate is deliberately NOT re-implemented here (it is pinned in
// tests/receiver-metadata-size.test.mjs and out of scope for this fix).
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

// ---- unhandled-rejection sentinel (must stay empty for the whole file) ----
const unhandledRejections = [];
const onUnhandled = (reason) => unhandledRejections.push(reason);
process.on('unhandledRejection', onUnhandled);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mock RTCDataChannel: send() records every message so we can assert no
// chunk is ever sent twice (the re-sent last chunk is what triggered the
// receiver's overshoot reject pre-fix).
function makeDataChannel() {
  const channel = {
    readyState: 'open',
    sentMessages: [],
    send(msg) {
      this.sentMessages.push(msg);
    },
    close() {
      this.readyState = 'closed';
    }
  };
  return channel;
}

// Faithful mirror of the post-fix Sender.svelte chunk pipeline, with an
// injectable "stop window" so the test can flip `stop` at exactly the
// moment between the final chunk's send() and the offset bookkeeping —
// i.e. inside sendBuffer(), after send() has run.
//
// `stopAt` (optional): when set to 'after-final-send', stop is flipped at
// the end of sendBuffer() for the final chunk — precisely the race window.
function buildSender({ key, name, size, chunkSize, stopAt }) {
  const dataChannel = makeDataChannel();
  const sendingFiles = {};
  const toasts = [];
  const sendingFile = {
    file: {
      name,
      slice(start, end) {
        const clampedEnd = Math.min(end, size);
        return { arrayBuffer: async () => new ArrayBuffer(Math.max(0, clampedEnd - start)) };
      }
    },
    metaData: { name, size, type: 'application/octet-stream', key: new Uint8Array() },
    progress: 0,
    bitrate: 0,
    stop: false,
    error: undefined,
    startTime: 0,
    status: 'Pending',
    aesKey: null
  };
  sendingFiles[key] = sendingFile;

  let offset = 0;
  const fileStats = { progress: 0, startTime: Date.now(), nextProgressUpdate: 0 };

  function send(message) {
    if (dataChannel.readyState !== 'open') return false;
    try {
      dataChannel.send(message);
      return true;
    } catch {
      return false;
    }
  }

  function markChunkFailed(err) {
    const message = err instanceof Error ? err.message : String(err);
    const entry = sendingFiles[key];
    if (entry && entry.status !== FileStatus.Success && !entry.stop) {
      entry.error = new Error(`Failed to send chunk: ${message}`);
      entry.status = FileStatus.Pending;
      toasts.push(`File ${sendingFile.metaData.name} failed to send: ${message}`);
    }
  }

  // Mirrors the post-fix sendBuffer(): returns `true` only when send()
  // actually ran (wire reality), `false` when stop bailed it out before
  // sending. stopAt='after-final-send' flips stop at the exact race window.
  async function sendBuffer(buffer) {
    const isFinalChunk = offset + buffer.byteLength >= size;
    if (sendingFile.stop) return false;
    const ok = send({ kind: 'chunk', key, bytes: buffer.byteLength });
    if (stopAt === 'after-final-send' && isFinalChunk && ok) {
      // The Stop button is clicked the instant the final chunk hits the wire,
      // before the offset bookkeeping in sendNextChunk() runs.
      sendingFile.stop = true;
    }
    return ok;
  }

  // Mirrors the post-fix sendNextChunk(): advances offset whenever
  // sendBuffer() reports a wire send, even when stop is set.
  async function sendNextChunk() {
    if (sendingFile.stop) return;
    const chunkBytes =
      Number.isFinite(Number(chunkSize)) && Number(chunkSize) > 0 ? Number(chunkSize) : 32 * 1024;
    const slice = sendingFile.file.slice(offset, offset + chunkBytes);
    const buffer = await slice.arrayBuffer();
    if (sendingFile.stop) return;
    if (buffer.byteLength === 0 && offset < sendingFile.metaData.size) {
      sendingFile.error = new Error('Invalid chunk size');
      sendingFile.status = FileStatus.Pending;
      toasts.push(`File ${sendingFile.metaData.name} failed: invalid chunk size`);
      return;
    }
    const sent = await sendBuffer(buffer);
    if (sent) {
      offset += buffer.byteLength;
    }
    if (sendingFile.stop) return;
    fileStats.progress = Math.round((offset / sendingFile.metaData.size) * 100);
    if (fileStats.progress >= fileStats.nextProgressUpdate) {
      sendingFile.progress = fileStats.progress;
      fileStats.nextProgressUpdate += 10;
      if (fileStats.nextProgressUpdate > 100) fileStats.nextProgressUpdate = 100;
    }
  }

  const event = new EventEmitter();
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
  // Mirrors the post-fix EVENT_RECEIVED_CHUNK handler: stop only matters
  // while bytes remain; a fully-delivered entry (offset >= size) still
  // completes, and a Success entry is never demoted by a stray ack.
  event.on('EVENT_RECEIVED_CHUNK', async () => {
    const f = sendingFiles[key];
    if (!f) return;
    if (f.stop && offset < sendingFile.metaData.size) return;
    if (f.status === FileStatus.Success) return;
    if (f.error || f.status != FileStatus.Processing) {
      f.progress = 0;
      f.status = FileStatus.Pending;
      f.stop = false;
      return;
    }
    if (offset < sendingFile.metaData.size) {
      try {
        await sendNextChunk();
      } catch (err) {
        markChunkFailed(err);
      }
      return;
    }
    const f2 = sendingFiles[key];
    if (!f2) return;
    f2.status = FileStatus.Success;
    f2.stop = false;
    toasts.push(`File ${sendingFile.metaData.name} sent successfully`);
  });
  event.on('EVENT_RECEIVER_REJECT', () => {
    const f = sendingFiles[key];
    if (!f) return;
    f.error = new Error('Receiver reject the file');
    f.status = FileStatus.Pending;
  });

  // Mirrors the metadata-send block in onSend (post-fix).
  async function onSendMetadata() {
    const ok = send({ kind: 'metaData', key });
    const f = sendingFiles[key];
    if (!f) return;
    if (ok) {
      f.status = FileStatus.WaitingAccept;
      return;
    }
    f.status = FileStatus.Pending;
  }

  // Mirrors the post-fix onContinue(): clears stop, emits a synthetic
  // RECEIVED_CHUNK. After the fix this path should be unreachable in the
  // final-ack race (the entry is already Success), so calling it must be a
  // harmless no-op that never re-sends a chunk.
  function onContinue() {
    const f = sendingFiles[key];
    if (!f) return;
    f.stop = false;
    f.event?.emit?.('EVENT_RECEIVED_CHUNK');
  }

  return {
    sendingFiles,
    toasts,
    dataChannel,
    event,
    onSendMetadata,
    onContinue
  };
}

// ---- Test 1: Stop during the final chunk's send/ack window still completes ----
// The exact irrecoverable sub-case from the task: stop flips between the
// final send() and the offset advance. The completion ack must still walk
// the entry to Success, stop must clear, and no chunk may be re-sent.
{
  const key = 'final-race';
  const sender = buildSender({
    key,
    name: 'final.bin',
    size: 300,
    chunkSize: 128,
    stopAt: 'after-final-send'
  });
  // 3 chunks: 128 + 128 + 44.
  await sender.onSendMetadata();
  assert.equal(sender.sendingFiles[key].status, FileStatus.WaitingAccept);

  sender.event.emit('EVENT_RECEIVER_ACCEPT');
  await delay(10); // chunk 0 sent
  sender.event.emit('EVENT_RECEIVED_CHUNK');
  await delay(10); // chunk 1 sent
  sender.event.emit('EVENT_RECEIVED_CHUNK');
  await delay(10); // final chunk (44B) sent, stop flipped inside sendBuffer()

  // The entry is now in the stuck state the bug produced: stop=true, but the
  // closure's offset has already advanced to size because the chunk hit the
  // wire. The channel saw exactly metadata + 3 chunks and nothing more.
  const entry = sender.sendingFiles[key];
  assert.equal(entry.stop, true, 'stop must be set by the race window');
  assert.equal(
    sender.dataChannel.sentMessages.filter((m) => m.kind === 'chunk').length,
    3,
    'exactly 3 chunks on the wire (no re-send yet)'
  );
  assert.equal(entry.status, FileStatus.Processing, 'still Processing before the completion ack');

  // The receiver's completion ack for the final chunk arrives. Pre-fix this
  // was dropped by `if (f.stop) return;` and the entry stayed stuck forever.
  sender.event.emit('EVENT_RECEIVED_CHUNK');
  await delay(10);

  assert.equal(
    entry.status,
    FileStatus.Success,
    'the completion ack must finish a fully delivered file even though stop was set'
  );
  assert.equal(entry.error, undefined, 'no error on the fully delivered file');
  assert.equal(
    entry.stop,
    false,
    'stop must be cleared on completion so the list stops rendering Continue'
  );
  assert.equal(
    sender.dataChannel.sentMessages.filter((m) => m.kind === 'chunk').length,
    3,
    'no chunk may be re-sent after the completion ack'
  );
  assert.equal(
    sender.toasts.filter((t) => /sent successfully/.test(t)).length,
    1,
    'exactly one success toast'
  );
  assert.doesNotMatch(
    sender.toasts.join('\n'),
    /Receiver reject|invalid chunk size|Failed to send chunk/i,
    'no reject / chunk-failure wording on a fully delivered file'
  );

  // Continue is never needed. If it were clicked anyway (e.g. the button was
  // still rendered when the ack raced in), it must be a harmless no-op: no
  // re-send, no demotion of Success back to Pending.
  sender.onContinue();
  await delay(10);
  assert.equal(
    entry.status,
    FileStatus.Success,
    'a stray Continue must not demote a Success entry'
  );
  assert.equal(
    sender.dataChannel.sentMessages.filter((m) => m.kind === 'chunk').length,
    3,
    'a stray Continue must not re-send an already-delivered chunk'
  );

  console.log(
    'ok - sender: Stop during the final chunk send/ack window still completes, no re-send'
  );
}

// ---- Test 2: mid-file Stop still pauses (the pre-fix behavior is preserved) ----
// A stop with bytes remaining is a genuine pause: the pipeline bails, the
// entry stays Processing with stop=true, and no further chunks go out. The
// completion-ack fix must not have made mid-file stops complete early.
{
  const key = 'mid-pause';
  const sender = buildSender({ key, name: 'mid.bin', size: 300, chunkSize: 128 });
  await sender.onSendMetadata();
  sender.event.emit('EVENT_RECEIVER_ACCEPT');
  await delay(10); // chunk 0 sent
  sender.event.emit('EVENT_RECEIVED_CHUNK');
  await delay(10); // chunk 1 sent

  // The user clicks Stop mid-file (offset 256 < size 300).
  sender.sendingFiles[key].stop = true;

  // An ack for chunk 1 arrives: stop is set and offset < size, so this must
  // be treated as a genuine pause — no next chunk, no completion.
  sender.event.emit('EVENT_RECEIVED_CHUNK');
  await delay(10);

  const entry = sender.sendingFiles[key];
  assert.equal(entry.stop, true, 'mid-file stop must keep the pause');
  assert.equal(entry.status, FileStatus.Processing, 'mid-file stop must not complete the file');
  assert.equal(
    sender.dataChannel.sentMessages.filter((m) => m.kind === 'chunk').length,
    2,
    'no further chunk may be sent after a mid-file stop'
  );
  assert.equal(
    sender.toasts.filter((t) => /sent successfully/.test(t)).length,
    0,
    'no success toast on a paused file'
  );
  console.log('ok - sender: mid-file Stop still pauses (no early completion, no extra chunk)');
}

// ---- Test 3: static guards — the real component implements the fix ----
{
  // The completion ack must not be dropped on stop when the file is fully
  // delivered: the guard must be `f.stop && offset < size`, not a bare
  // `if (f.stop) return;`.
  assert.ok(
    /if\s*\(\s*f\.stop\s*&&\s*offset\s*<\s*sendingFile\.metaData\.size\s*\)/.test(senderSource),
    'the RECEIVED_CHUNK handler must only bail on stop while bytes remain (f.stop && offset < size)'
  );
  assert.ok(
    !/if\s*\(\s*f\.stop\s*\)\s*\{?\s*return\s*;/.test(senderSource),
    'the RECEIVED_CHUNK handler must NOT unconditionally drop the ack on f.stop'
  );

  // A terminal Success entry must be protected from demotion by a stray ack.
  assert.ok(
    /if\s*\(\s*f\.status\s*===\s*FileStatus\.Success\s*\)\s*\{/.test(senderSource),
    'the RECEIVED_CHUNK handler must treat Success as terminal (no bounce back to Pending)'
  );

  // On completion, stop must be cleared so the list stops rendering Continue.
  assert.ok(
    /f2\.stop\s*=\s*false;/.test(senderSource),
    'completion must clear f.stop so the entry no longer renders a Continue button'
  );

  // sendBuffer() must report wire reality: return true only when send() ran,
  // false when it bailed on stop before sending.
  const sendBufferIdx = senderSource.search(/async\s+function\s+sendBuffer\s*\(/);
  assert.ok(sendBufferIdx !== -1, 'sendBuffer() must exist');
  const sendBufferEnd = senderSource.search(/async\s+function\s+sendNextChunk\s*\(/);
  const sendBufferBody = senderSource.slice(sendBufferIdx, sendBufferEnd);
  assert.ok(
    /if\s*\(\s*sendingFile\.stop\s*\)\s*return\s+false;/.test(sendBufferBody),
    'sendBuffer() must return false when stop bails it out before sending'
  );
  assert.ok(
    /return\s+true;/.test(sendBufferBody),
    'sendBuffer() must return true when the chunk actually went on the wire'
  );

  // sendNextChunk() must advance offset whenever sendBuffer() reports a wire
  // send — not unconditionally after the stop re-check (which is what left
  // offset behind the wire when stop flipped mid-final-chunk).
  const sendNextIdx = senderSource.search(/async\s+function\s+sendNextChunk\s*\(/);
  assert.ok(sendNextIdx !== -1, 'sendNextChunk() must exist');
  const sendNextEnd = senderSource.indexOf('\n    }', sendNextIdx + 200);
  const sendNextBody = senderSource.slice(sendNextIdx, sendNextEnd > -1 ? sendNextEnd : undefined);
  assert.ok(
    /const\s+sent\s*=\s*await\s+sendBuffer\(buffer\);/.test(sendNextBody),
    'sendNextChunk() must capture sendBuffer() wire-reality return'
  );
  assert.ok(
    /if\s*\(\s*sent\s*\)\s*\{[\s\S]*?offset\s*\+=\s*buffer\.byteLength;/.test(sendNextBody),
    'sendNextChunk() must advance offset only when the chunk actually hit the wire'
  );

  // The irrecoverable sub-case must be gone: the old pattern that advanced
  // offset unconditionally *after* the stop re-check (skipping it on stop)
  // is the bug. Pin the corrected ordering: offset advance is gated on
  // `sent`, and the stop re-check that returns early happens only AFTER.
  assert.ok(
    !/await\s+sendBuffer\(buffer\);[\s\S]{0,120}?if\s*\(\s*sendingFile\.stop\s*\)\s*return;[\s\S]{0,80}?offset\s*\+=\s*buffer\.byteLength;/.test(
      senderSource
    ),
    'offset must not be advanced unconditionally after the stop re-check (the old bug)'
  );

  console.log('ok - static: Sender.svelte keeps the stop-vs-final-ack fix shape');
}

// ---- final: no unhandled rejections escaped anywhere in this suite ----
{
  await delay(50);
  assert.equal(
    unhandledRejections.length,
    0,
    `no unhandled promise rejections allowed; got: ${JSON.stringify(
      unhandledRejections.map((r) => String(r))
    )}`
  );
  process.off('unhandledRejection', onUnhandled);
  console.log('ok - no unhandled rejections across the stop-vs-final-ack scenarios');
}

console.log(
  'ok - sender stop-vs-final-ack: fully delivered file completes, no re-send, mid-file pause intact'
);
