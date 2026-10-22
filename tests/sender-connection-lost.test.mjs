// Regression guard for "channel closed mid-transfer" on the sender side:
// when the peer's data channel dies while a file is mid-transfer, the chunk
// pipeline threw InvalidStateError per chunk and the failures surfaced as
// "File X failed to send: ..." with the raw channel error (misleading — the
// real cause is connection loss); a file merely waiting for the next
// EVENT_RECEIVED_CHUNK ack dead-ended in Processing forever; and Resend on
// the dead channel threw at the metadata send and surfaced "Failed to encode
// file metadata" with the file stuck in Pending.
//
// The fix: Sender.svelte now keeps a `connectionLost` flag, a guarded send()
// (readyState check + try/catch), and an exported onChannelClose() that the
// owning page's dataChannel onclose/onerror fires: it marks every
// non-Success file with the accurate "Connection lost — transfer aborted"
// error (single toast per file), stops the in-flight pipelines, and the
// metadata send yields the connection-lost error instead of an encode error.
//
// This test drives the sender through a REAL eventemitter3 event wiring
// (same harness style as tests/sender-chunk-failure.test.mjs and
// tests/receiver-chunk-order.test.mjs) with a mock dataChannel whose send()
// throws InvalidStateError once the channel is closed.
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

const CLOSED_CHANNEL_ERR = new DOMException('The channel is no longer open', 'InvalidStateError');

// ---- unhandled-rejection sentinel (must stay empty for the whole file) ----
const unhandledRejections = [];
const onUnhandled = (reason) => unhandledRejections.push(reason);
process.on('unhandledRejection', onUnhandled);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mock RTCDataChannel: send() works while open and throws the real
// InvalidStateError the platform raises after close(), like a browser channel.
function makeDataChannel() {
  let closed = false;
  const channel = {
    readyState: 'open',
    sentMessages: [],
    send(msg) {
      if (closed) throw CLOSED_CHANNEL_ERR;
      this.sentMessages.push(msg);
    },
    close() {
      closed = true;
      this.readyState = 'closed';
    }
  };
  return channel;
}

// Faithful mirror of the post-fix Sender.svelte onSend chunk pipeline: the
// ACCEPT / RECEIVED_CHUNK handlers, markChunkFailed, sendBuffer,
// sendNextChunk, the guarded send(), and the metadata-send try/catch.
// encryptAesGcm is stubbed to a near-synchronous real transform so the
// pipeline is exercised without WebCrypto round-trips (this test is about
// channel-close semantics, not encryption).
function buildSender({ key, name, size, chunkSize, dataChannel, connectionLost }) {
  const sendingFiles = {};
  const toasts = [];
  const sendingFile = {
    file: {
      name,
      slice(start, end) {
        // like the real File.slice: clamp the end to the file's actual size so
        // the final chunk is short (300 with 128B chunks -> 128 + 128 + 44).
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
    if (connectionLost || dataChannel.readyState !== 'open') {
      return false;
    }
    try {
      dataChannel.send(message);
      return true;
    } catch {
      connectionLost = true;
      return false;
    }
  }

  function onChannelClose() {
    if (connectionLost) return;
    connectionLost = true;
    for (const k of Object.keys(sendingFiles)) {
      const f = sendingFiles[k];
      if (!f || f.status === FileStatus.Success) continue;
      if (f.status === FileStatus.Processing) {
        f.stop = true;
      }
      f.error = new Error('Connection lost — transfer aborted');
      f.status = FileStatus.Pending;
      f.progress = 0;
      toasts.push(`File ${f.metaData.name}: connection lost — transfer aborted`);
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

  async function sendBuffer(buffer) {
    const encrypted = await Promise.resolve(new Uint8Array(buffer)); // stub encryptAesGcm
    if (sendingFile.stop) return false;
    send({ kind: 'chunk', key });
    return true;
  }

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
  event.on('EVENT_VALIDATE_ERROR', () => {
    const f = sendingFiles[key];
    if (!f) return;
    f.error = new Error('Receiver validate error');
    f.status = FileStatus.Pending;
  });
  event.on('EVENT_RECEIVER_REJECT', () => {
    const f = sendingFiles[key];
    if (!f) return;
    f.error = new Error('Receiver reject the file');
    f.status = FileStatus.Pending;
  });

  // Mirrors the metadata-send block in onSend (post-fix): guarded send first.
  async function onSendMetadata() {
    try {
      const ok = send({ kind: 'metaData', key });
      const f = sendingFiles[key];
      if (!f) return;
      if (ok) {
        f.status = FileStatus.WaitingAccept;
        return;
      }
      if (!f.error) {
        f.error = new Error('Connection lost — transfer aborted');
        toasts.push(`File ${sendingFile.metaData.name}: connection lost — transfer aborted`);
      }
      f.status = FileStatus.Pending;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const f = sendingFiles[key];
      if (f) {
        f.error = new Error(`Failed to encode file metadata: ${message}`);
        f.status = FileStatus.Pending;
      }
      toasts.push(`File ${sendingFile.metaData.name} failed: ${message}`);
    }
  }

  async function onContinue() {
    const f = sendingFiles[key];
    if (!f) return;
    if (connectionLost) return;
    f.stop = false;
    f.event?.emit('EVENT_RECEIVED_CHUNK');
  }

  return {
    sendingFiles,
    toasts,
    dataChannel,
    event,
    onSendMetadata,
    onChannelClose,
    onContinue,
    markChunkFailed,
    send
  };
}

// ---- Test 1: channel dies mid-send -> single accurate connection-lost error ----
{
  const key = 'file-inflight';
  const dataChannel = makeDataChannel();
  const sender = buildSender({
    key,
    name: 'a.bin',
    size: 300,
    chunkSize: 128,
    dataChannel,
    connectionLost: false
  });

  // The file is mid-transfer: accept arrived, first chunk sent, waiting for
  // the next EVENT_RECEIVED_CHUNK ack.
  await sender.onSendMetadata();
  assert.equal(sender.sendingFiles[key].status, FileStatus.WaitingAccept);
  sender.event.emit('EVENT_RECEIVER_ACCEPT');
  await delay(10); // let the ACCEPT handler's sendNextChunk settle
  assert.equal(sender.sendingFiles[key].status, FileStatus.Processing);

  // The peer's channel dies mid-transfer: the page's onclose fires
  // onChannelClose(); queued acks keep arriving from the dead pipeline.
  dataChannel.close();
  sender.onChannelClose();

  // An ack event that slips through must not re-enter the send pipeline with
  // a misleading chunk failure.
  sender.event.emit('EVENT_RECEIVED_CHUNK');
  await delay(10);

  const entry = sender.sendingFiles[key];
  assert.equal(entry.status, FileStatus.Pending, 'the in-flight file must leave Processing');
  assert.ok(entry.error instanceof Error, 'the in-flight file must carry an error');
  assert.match(entry.error.message, /connection lost/i, 'the error must say connection lost');
  assert.doesNotMatch(
    entry.error.message,
    /InvalidStateError|Failed to send chunk/,
    'no misleading chunk-send/InvalidStateError wording'
  );
  assert.equal(
    sender.toasts.filter((t) => /connection lost/i.test(t)).length,
    1,
    'exactly one "connection lost" toast for the file'
  );
  assert.doesNotMatch(
    sender.toasts.join('\n'),
    /Failed to send chunk|corrupt chunk/,
    'no per-chunk failure toasts for a connection loss'
  );
  // No chunk may have been sent on the dead channel.
  assert.equal(dataChannel.sentMessages.length, 2, 'only the metadata + first chunk were sent');

  console.log(
    'ok - sender: channel close mid-transfer -> single connection-lost error, leaves Processing'
  );
}

// ---- Test 2: Resend on a dead channel -> immediate connection-lost, not an encode error ----
{
  const key = 'file-resend';
  const dataChannel = makeDataChannel();
  const sender = buildSender({
    key,
    name: 'b.bin',
    size: 300,
    chunkSize: 128,
    dataChannel,
    connectionLost: false
  });

  // The channel is already dead when the (re)send starts.
  dataChannel.close();
  sender.onChannelClose();

  await sender.onSendMetadata();
  const entry = sender.sendingFiles[key];
  assert.equal(entry.status, FileStatus.Pending, 'Resend on a dead channel must bounce to Pending');
  assert.match(entry.error.message, /connection lost/i, 'Resend must surface connection lost');
  assert.doesNotMatch(
    entry.error.message,
    /Failed to encode file metadata|InvalidStateError/,
    'Resend must NOT surface the misleading metadata-encode error'
  );
  assert.equal(
    sender.toasts.filter((t) => /connection lost/i.test(t)).length,
    1,
    'exactly one connection-lost toast'
  );
  assert.equal(dataChannel.sentMessages.length, 0, 'nothing may be sent on the dead channel');

  console.log(
    'ok - sender: Resend on a dead channel surfaces connection lost, not a metadata-encode error'
  );
}

// ---- Test 3: a live channel keeps working end-to-end (no false connection-lost) ----
{
  const key = 'file-live';
  const dataChannel = makeDataChannel();
  const sender = buildSender({
    key,
    name: 'ok.bin',
    size: 300,
    chunkSize: 128, // 3 chunks: 128 + 128 + 44
    dataChannel,
    connectionLost: false
  });

  await sender.onSendMetadata();
  assert.equal(sender.sendingFiles[key].status, FileStatus.WaitingAccept);
  sender.event.emit('EVENT_RECEIVER_ACCEPT');
  await delay(10); // chunk 0 sent
  sender.event.emit('EVENT_RECEIVED_CHUNK');
  await delay(10); // chunk 1 sent
  sender.event.emit('EVENT_RECEIVED_CHUNK');
  await delay(10); // chunk 2 sent
  // The sender is one round-trip ahead: the LAST chunk's own ack is what walks
  // it to offset >= size and marks Success (the receiver acks every chunk).
  sender.event.emit('EVENT_RECEIVED_CHUNK');
  await delay(10);
  assert.equal(
    sender.sendingFiles[key].status,
    FileStatus.Success,
    'a live channel must still complete the transfer'
  );
  assert.equal(sender.sendingFiles[key].error, undefined, 'no error on a clean live transfer');
  assert.equal(
    dataChannel.sentMessages.length,
    4,
    'metadata + 3 chunks must all reach the live channel'
  );
  assert.doesNotMatch(
    sender.toasts.join('\n'),
    /connection lost/i,
    'no connection-lost toasts on a live channel'
  );
  console.log('ok - sender: live-channel behavior intact (metadata + chunks + Success)');
}

// ---- Test 4: static guards — the component actually implements the fix ----
{
  // The guarded-send body now lives exactly once in the shared
  // src/utils/channelSender.ts helper (pinned in tests/channel-sender.test.mjs):
  // the component must use it, and must no longer carry its own copy.
  assert.ok(
    senderSource.includes("import { createChannelSender } from '../../utils/channelSender';"),
    'Sender.svelte must import createChannelSender from ../../utils/channelSender'
  );
  assert.ok(
    /createChannelSender\(dataChannel\)/.test(senderSource),
    'Sender.svelte must build its guarded send from createChannelSender(dataChannel)'
  );
  assert.equal(
    (senderSource.match(/dataChannel\.send\(/g) || []).length,
    0,
    'Sender.svelte must not call dataChannel.send directly — every send goes through the shared guarded helper'
  );
  assert.ok(
    !/function\s+send\s*\(\s*message:\s*Uint8Array\s*\):\s*boolean\s*\{[\s\S]{0,300}?dataChannel\.readyState/.test(
      senderSource
    ),
    'Sender.svelte must no longer define its own guarded send body (readyState check)'
  );
  // The old full guarded body is gone; what remains is exactly one thin
  // wrapper that delegates to the helper and mirrors the helper's lost flag
  // into the $state UI gate (the wrapper shape is pinned below).
  assert.equal(
    (senderSource.match(/function\s+send\s*\(\s*message:\s*Uint8Array\s*\):\s*boolean/g) || [])
      .length,
    1,
    'Sender.svelte must define exactly one send() wrapper around the helper'
  );

  // onChannelClose(): exported, single-fires via the helper, stops in-flight
  // pipelines and marks the files with the accurate error.
  assert.ok(
    /export\s+function\s+onChannelClose\s*\(\s*\)/.test(senderSource),
    'Sender.svelte must export onChannelClose()'
  );
  assert.ok(
    /if\s*\(\s*channelSender\.isLost\(\)\s*\)\s*return;\s*channelSender\.markLost\(\);/.test(
      senderSource
    ),
    'onChannelClose() must be single-fire via the helper (guard isLost() then markLost())'
  );
  assert.match(senderSource, /Connection lost — transfer aborted/);
  assert.ok(
    /f\.stop\s*=\s*true;/.test(senderSource),
    'onChannelClose() must stop in-flight send pipelines'
  );
  // The live connectionLost flag reaches the list (Resend/Continue/Send
  // gating). It is a $state the template reacts to (flipped in onChannelClose()
  // and the send() wrapper) — NOT a $derived over channelSender.isLost():
  // isLost() reads a plain closure variable and touches no Svelte signal, so
  // a $derived over it evaluates once and caches `false` forever, and the gate
  // never engaged after a connection loss.
  assert.ok(
    /let\s+connectionLost\s*=\s*\$state\(false\)/.test(senderSource),
    'the connectionLost gate must be a $state the template reacts to (not a $derived over isLost())'
  );
  assert.ok(
    !/connectionLost\s*=\s*\$derived\(channelSender\.isLost\(\)\)/.test(senderSource),
    'connectionLost must NOT be a $derived over channelSender.isLost() (reads no signal -> permanently cached false)'
  );
  assert.equal(
    (senderSource.match(/connectionLost\s*=\s*true;/g) || []).length,
    2,
    'connectionLost must be flipped exactly twice: in onChannelClose() and the send() wrapper'
  );
  const ocIdx = senderSource.search(/export\s+function\s+onChannelClose\s*\(\s*\)/);
  assert.ok(ocIdx !== -1, 'onChannelClose() must be exported');
  const ocBody = senderSource.slice(ocIdx, ocIdx + 600);
  assert.ok(
    /connectionLost\s*=\s*true;/.test(ocBody),
    'onChannelClose() must set connectionLost = true (the UI gate flips with the channel)'
  );
  // The send() wrapper mirrors the helper's lost flag into the UI flag: when a
  // throwing send() wins the race (the channel throws before onclose fires,
  // so the close handler never runs), the helper flips its own flag and the
  // wrapper must propagate it, or the gate would stay open on that path.
  const swIdx = senderSource.search(
    /function\s+send\s*\(\s*message:\s*Uint8Array\s*\)\s*:\s*boolean/
  );
  assert.ok(swIdx !== -1, 'Sender.svelte must define a send() wrapper around the helper send');
  const swBody = senderSource.slice(swIdx, swIdx + 400);
  assert.ok(
    /channelSender\.send\(message\)/.test(swBody) &&
      /channelSender\.isLost\(\)\s*\)\s*connectionLost\s*=\s*true;/.test(swBody),
    'the send() wrapper must call channelSender.send() and mirror isLost() into connectionLost'
  );
  // The chunk sends and the metadata send go through the guarded helper.
  const sendBufferMatch = senderSource.search(/async\s+function\s+sendBuffer\s*\(/);
  assert.ok(sendBufferMatch !== -1, 'sendBuffer() must exist');
  const sendBufferBody = senderSource.slice(
    sendBufferMatch,
    senderSource.search(/async\s+function\s+sendNextChunk\s*\(/)
  );
  assert.ok(
    !/dataChannel\.send\(/.test(sendBufferBody),
    'sendBuffer() must not call dataChannel.send directly'
  );
  assert.ok(
    !/dataChannel\.send\(\s*\n\s*Message\.encode\(\{\s*\n\s*id:\s*key,\s*\n\s*metaData:/.test(
      senderSource
    ),
    'the metadata send must not call dataChannel.send directly'
  );

  // The page propagates the channel close/error into the pipelines.
  const offerPage = readFileSync(join(here, '..', 'src', 'components', 'OfferPage.svelte'), 'utf8');
  const receivePage = readFileSync(
    join(here, '..', 'src', 'components', 'ReceivePage.svelte'),
    'utf8'
  );
  for (const [name, source] of [
    ['OfferPage.svelte', offerPage],
    ['ReceivePage.svelte', receivePage]
  ]) {
    assert.equal(
      (source.match(/sender\?\.onChannelClose\(\);/g) || []).length,
      2,
      `${name}: sender?.onChannelClose() must be wired into both onclose and onerror`
    );
    assert.equal(
      (source.match(/receiver\?\.onChannelClose\(\);/g) || []).length,
      2,
      `${name}: receiver?.onChannelClose() must be wired into both onclose and onerror`
    );
  }
  console.log('ok - static: sender guarded send + onChannelClose + page wiring');
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
  console.log('ok - no unhandled rejections across the connection-lost sender scenarios');
}

console.log(
  'ok - sender channel close: no misleading chunk/metadata errors, in-flight files leave Processing'
);
