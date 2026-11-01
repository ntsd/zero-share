// Regression guard for "channel closed mid-transfer" on the receiver side:
// when the peer's data channel dies (tab closed, network drop, or the sender
// regenerating the offer link) while chunks for an in-flight file are still
// enqueued, the per-file chunkQueue chain kept running and every queued chunk
// failed at the ack send with InvalidStateError, then got reported as
// "A received chunk failed to decrypt (corrupt data in transit)" — a
// completely wrong error — repeated once per chunk until the queue drained,
// with an unhandled rejection on the onChunkData().catch path and the
// per-file chunk maps never torn down.
//
// The fix: Receiver.svelte now keeps a `connectionLost` flag, a guarded
// send() (readyState check + try/catch), and an exported onChannelClose()
// that the owning page's dataChannel onclose/onerror fires: it marks every
// non-Success file with the accurate "Connection lost — transfer aborted"
// error (single toast per file) and deletes receivingFileChunkMap /
// receivingFileStatsMap / chunkQueue so the remaining enqueued chunks are
// dropped by onChunkData instead of re-entering processChunk.
//
// This test drives the receiver through the REAL serializeTask + real
// WebCrypto AES-GCM (same harness style as
// tests/receiver-chunk-failure.test.mjs) with a mock dataChannel whose
// send() throws InvalidStateError once the channel is closed.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { serializeTask } = await import(join(here, '..', 'src', 'utils', 'serialize.ts'));
const { generateAesKey, encryptAesGcm, decryptAesGcm } = await import(
  join(here, '..', 'src', 'utils', 'crypto.ts')
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isEncrypt = true;
const CLOSED_CHANNEL_ERR = new DOMException('The channel is no longer open', 'InvalidStateError');

// ---- unhandled-rejection sentinel (must stay empty for the whole file) ----
const unhandledRejections = [];
const onUnhandled = (reason) => unhandledRejections.push(reason);
process.on('unhandledRejection', onUnhandled);

function chunksFor(source, chunkSize) {
  const chunks = [];
  for (let off = 0; off < source.length; off += chunkSize) {
    chunks.push(source.subarray(off, Math.min(off + chunkSize, source.length)));
  }
  return chunks;
}

function makeSource(size) {
  const source = new Uint8Array(size);
  for (let i = 0; i < size; i++) source[i] = (i * 7 + 3) & 0xff;
  return source;
}

// Mock RTCDataChannel: send() works while open and throws the real
// InvalidStateError the platform raises after close(), like a browser channel.
function makeDataChannel() {
  let closed = false;
  const channel = {
    readyState: 'open',
    send() {
      if (closed) throw CLOSED_CHANNEL_ERR;
    },
    close() {
      closed = true;
      this.readyState = 'closed';
    }
  };
  return channel;
}

// Faithful mirror of the post-fix Receiver.svelte chunk pipeline:
// onChunkData / processChunk / rejectCorruptChunk / onChannelClose + the
// guarded send(), with REAL decryptAesGcm so the live-channel control in the
// last test fails GCM authentication for real.
function buildReceiver({ size, name }) {
  const ID = 'file-1';
  const state = {
    receivingFiles: {
      [ID]: {
        metaData: { name, size, type: 'application/octet-stream', key: new Uint8Array() },
        progress: 0,
        bitrate: 0,
        startTime: 0,
        status: 'Processing',
        aesKey: null
      }
    },
    receivingFileChunkMap: { [ID]: { receivedChunks: [] } },
    receivingFileStatsMap: {
      [ID]: { progress: 0, startTime: 0, nextProgressUpdate: 0, receivedSize: 0 }
    },
    chunkQueue: {}
  };
  const toasts = [];
  const sentEvents = [];
  const dataChannel = makeDataChannel();
  let connectionLost = false;

  function send(message) {
    if (connectionLost || dataChannel.readyState !== 'open') {
      return false;
    }
    try {
      dataChannel.send(message);
      sentEvents.push(message);
      return true;
    } catch {
      connectionLost = true;
      return false;
    }
  }

  function rejectCorruptChunk(id, receivingFile) {
    if (!state.receivingFileChunkMap[id]) {
      return;
    }
    receivingFile.error = new Error('A received chunk failed to decrypt (corrupt data in transit)');
    receivingFile.status = 'Pending';
    toasts.push(`${receivingFile.metaData.name} failed: corrupt chunk (decryption error)`);
    send('EVENT_RECEIVER_REJECT');
    delete state.receivingFileChunkMap[id];
    delete state.receivingFileStatsMap[id];
    delete state.chunkQueue[id];
  }

  async function processChunk(id, receivingFile, chunk) {
    let arrayBuffer = chunk;
    if (isEncrypt && receivingFile.aesKey) {
      try {
        arrayBuffer = await decryptAesGcm(receivingFile.aesKey, arrayBuffer);
      } catch {
        rejectCorruptChunk(id, receivingFile);
        return;
      }
    }
    const chunkMap = state.receivingFileChunkMap[id];
    if (!chunkMap) {
      return;
    }
    send('EVENT_RECEIVED_CHUNK');
    const receivingSize = arrayBuffer.byteLength;
    chunkMap.receivedChunks.push(arrayBuffer);
    state.receivingFileStatsMap[id].receivedSize += receivingSize;
    if (state.receivingFileStatsMap[id].receivedSize >= receivingFile.metaData.size) {
      state.receivingFiles[id].status = 'Success';
      delete state.receivingFileChunkMap[id];
      delete state.receivingFileStatsMap[id];
      delete state.chunkQueue[id];
    }
  }

  function onChannelClose() {
    if (connectionLost) return;
    connectionLost = true;
    for (const id of Object.keys(state.receivingFiles)) {
      const f = state.receivingFiles[id];
      if (f.status === 'Success') continue;
      f.error = new Error('Connection lost — transfer aborted');
      f.status = 'Pending';
      toasts.push(`${f.metaData.name}: connection lost — transfer aborted`);
    }
    for (const id of Object.keys(state.receivingFileChunkMap)) {
      delete state.receivingFileChunkMap[id];
      delete state.receivingFileStatsMap[id];
      delete state.chunkQueue[id];
    }
  }

  // Mirrors onChunkData; captures the chain promises so the test can await
  // them settling (the component fire-and-forgets via .catch).
  const inFlight = [];
  function onChunkData(id, chunk) {
    const receivingFile = state.receivingFiles[id];
    if (!receivingFile || !state.receivingFileChunkMap[id]) {
      return;
    }
    inFlight.push(
      serializeTask(state.chunkQueue, id, () => processChunk(id, receivingFile, chunk)).catch(
        () => {
          rejectCorruptChunk(id, receivingFile);
        }
      )
    );
  }

  function onRemove(key) {
    if (state.receivingFiles[key].status != 'Success') {
      send('EVENT_RECEIVER_REJECT');
    }
    delete state.receivingFileChunkMap[key];
    delete state.receivingFileStatsMap[key];
    delete state.chunkQueue[key];
    delete state.receivingFiles[key];
  }

  async function settle() {
    await Promise.all(inFlight);
  }

  return {
    ID,
    state,
    toasts,
    sentEvents,
    dataChannel,
    onChunkData,
    onChannelClose,
    onRemove,
    settle
  };
}

// ---- Test 1: channel dies mid-transfer -> clean exit, no false errors ----
{
  const SIZE = 300;
  const CHUNK = 128; // 3 chunks: 128 + 128 + 44
  const source = makeSource(SIZE);
  const plaintextChunks = chunksFor(source, CHUNK);

  const aesKey = await generateAesKey();
  const encrypted = [];
  for (const pc of plaintextChunks) {
    encrypted.push(await encryptAesGcm(aesKey, pc.slice().buffer));
  }

  const receiver = buildReceiver({ size: SIZE, name: 'a.bin' });
  receiver.state.receivingFiles[receiver.ID].aesKey = aesKey;

  // Drive all three chunks through onChunkData (synchronous, in arrival order)
  // — exactly like the data channel message handler — while the channel is
  // live, then let the peer close it mid-transfer.
  encrypted.forEach((c) => receiver.onChunkData(receiver.ID, c));
  receiver.dataChannel.close();
  receiver.onChannelClose(); // the page's onclose handler fires this
  await receiver.settle();

  const file = receiver.state.receivingFiles[receiver.ID];
  assert.equal(
    file.status,
    'Pending',
    'the in-flight file must bounce to Pending, not stay stuck in Processing'
  );
  assert.ok(file.error instanceof Error, 'the in-flight file must carry an error');
  assert.match(
    file.error.message,
    /connection lost/i,
    'the error must say the connection was lost, not that data was corrupt'
  );
  assert.doesNotMatch(file.error.message, /corrupt|decrypt/i, 'no corrupt-chunk wording');

  // No false "corrupt chunk (decryption error)" toast may have fired.
  assert.doesNotMatch(receiver.toasts.join('\n'), /corrupt chunk/i, 'no corrupt-chunk toasts');
  assert.equal(
    receiver.toasts.filter((t) => /connection lost/i.test(t)).length,
    1,
    'exactly one "connection lost" toast for the single in-flight file'
  );

  // No reject may have been sent for a connection loss (nothing was corrupt).
  assert.equal(
    receiver.sentEvents.filter((e) => e === 'EVENT_RECEIVER_REJECT').length,
    0,
    'a closed channel must not produce EVENT_RECEIVER_REJECT'
  );

  // The per-file chunk state must have been torn down.
  assert.equal(receiver.state.receivingFileChunkMap[receiver.ID], undefined);
  assert.equal(receiver.state.receivingFileStatsMap[receiver.ID], undefined);
  assert.equal(receiver.state.chunkQueue[receiver.ID], undefined);

  // Chunks that were already enqueued when the channel died must be dropped
  // by onChunkData (chunk map gone) — not re-enter processChunk and re-fire.
  encrypted.forEach((c) => receiver.onChunkData(receiver.ID, c));
  await receiver.settle();
  assert.doesNotMatch(
    receiver.toasts.join('\n'),
    /corrupt chunk|decrypt/i,
    'replayed in-flight chunks must not produce repeated corrupt-chunk errors'
  );
  assert.equal(
    receiver.toasts.filter((t) => /connection lost/i.test(t)).length,
    1,
    'replayed in-flight chunks must not add more connection-lost toasts'
  );

  // remove-in-flight must keep working on a dead channel (send no-ops, no throw).
  receiver.onRemove(receiver.ID);
  assert.equal(receiver.state.receivingFiles[receiver.ID], undefined);

  console.log(
    'ok - receiver: channel close mid-transfer -> single connection-lost error, clean teardown'
  );
}

// ---- Test 2: control — a GENUINELY corrupt chunk on a LIVE channel still
// surfaces the corrupt-chunk path (the live behavior this fix must not break).
{
  const SIZE = 300;
  const CHUNK = 128;
  const source = makeSource(SIZE);
  const plaintextChunks = chunksFor(source, CHUNK);

  const aesKey = await generateAesKey();
  const encrypted = [];
  for (const pc of plaintextChunks) {
    encrypted.push(await encryptAesGcm(aesKey, pc.slice().buffer));
  }
  // Corrupt the middle chunk: flip a ciphertext byte (past the 12-byte IV) so
  // the GCM auth tag no longer matches.
  encrypted[1][40] ^= 0xff;

  const receiver = buildReceiver({ size: SIZE, name: 'corrupt-live.bin' });
  receiver.state.receivingFiles[receiver.ID].aesKey = aesKey;
  encrypted.forEach((c) => receiver.onChunkData(receiver.ID, c));
  await receiver.settle();

  const file = receiver.state.receivingFiles[receiver.ID];
  assert.equal(file.status, 'Pending', 'a corrupt chunk on a live channel must bounce to Pending');
  assert.match(
    file.error.message,
    /decrypt|corrupt/i,
    'the corrupt-chunk error must remain accurate'
  );
  assert.match(
    receiver.toasts.join('\n'),
    /corrupt chunk \(decryption error\)/i,
    'the live-channel corrupt-chunk toast must still fire'
  );
  assert.equal(
    receiver.sentEvents.filter((e) => e === 'EVENT_RECEIVER_REJECT').length,
    1,
    'a live-channel corrupt chunk must still send exactly one EVENT_RECEIVER_REJECT'
  );
  console.log(
    'ok - receiver: live-channel corrupt chunk still rejects accurately (behavior intact)'
  );
}

// ---- Test 3: static guards — the component actually implements the fix ----
{
  const receiverSource = readFileSync(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );

  // The guarded-send body now lives exactly once in the shared
  // src/utils/channelSender.ts helper (pinned in tests/channel-sender.test.mjs):
  // the component must use it, and must no longer carry its own copy.
  assert.ok(
    receiverSource.includes("import { createChannelSender } from '../../utils/channelSender';"),
    'Receiver.svelte must import createChannelSender from ../../utils/channelSender'
  );
  assert.ok(
    /createChannelSender\(dataChannel\)/.test(receiverSource),
    'Receiver.svelte must build its guarded send from createChannelSender(dataChannel)'
  );
  assert.equal(
    (receiverSource.match(/dataChannel\.send\(/g) || []).length,
    0,
    'Receiver.svelte must not call dataChannel.send directly — every send goes through the shared guarded helper'
  );
  assert.ok(
    !/function\s+send\s*\(\s*message:\s*Uint8Array\s*\):\s*boolean/.test(receiverSource),
    'Receiver.svelte must no longer define its own guarded send(message): boolean body'
  );

  // onChannelClose(): exported, single-fires via the helper, marks the files,
  // tears down the per-file chunk state.
  assert.ok(
    /export\s+function\s+onChannelClose\s*\(\s*\)/.test(receiverSource),
    'Receiver.svelte must export onChannelClose()'
  );
  assert.ok(
    /if\s*\(\s*channelSender\.isLost\(\)\s*\)\s*return;\s*channelSender\.markLost\(\);/.test(
      receiverSource
    ),
    'onChannelClose() must be single-fire via the helper (guard isLost() then markLost())'
  );
  assert.match(receiverSource, /Connection lost — transfer aborted/);
  for (const map of [
    'delete receivingFileChunkMap[id]',
    'delete receivingFileStatsMap[id]',
    'delete chunkQueue[id]'
  ]) {
    assert.ok(receiverSource.includes(map), `onChannelClose() must tear down: ${map}`);
  }

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
    const closeHandlers = source.match(/dataChannel\.on(?:close|error)\s*=/g) || [];
    assert.ok(closeHandlers.length >= 2, `${name}: onclose/onerror handlers must still exist`);
    // The death handlers no longer carry the pipeline calls inline: both
    // pages delegate dataChannel.onclose/onerror to the shared teardown
    // (tests/dead-channel-peer-close.test.mjs pins the delegation), and the
    // helper propagates "connection lost" into both pipelines — so each page
    // must pass live sender/receiver getters instead of a copied call site.
    assert.ok(
      /getSender\s*:\s*\(\)\s*=>\s*sender/.test(source),
      `${name} must pass its live Sender ref to the shared teardown (getSender: () => sender)`
    );
    assert.ok(
      /getReceiver\s*:\s*\(\)\s*=>\s*receiver/.test(source),
      `${name} must pass its live Receiver ref to the shared teardown (getReceiver: () => receiver)`
    );
  }
  console.log('ok - static: receiver guarded send + onChannelClose + page wiring');
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
  console.log('ok - no unhandled rejections across the connection-lost receiver scenarios');
}

console.log(
  'ok - receiver channel close: no false corrupt-chunk errors, no unhandled rejections, chunk maps cleaned'
);
