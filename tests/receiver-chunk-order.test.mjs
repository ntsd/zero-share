import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for the P0 receiver corruption: with encryption enabled,
// onChunkData awaited decryptAesGcm (WebCrypto, async) BEFORE pushing the
// decrypted chunk. WebCrypto completion order is not guaranteed to match
// invocation order, so chunk N+1 could be pushed before chunk N and the
// assembled file silently corrupted. The fix serializes per-file chunk
// processing on a promise chain (src/utils/serialize.ts); this test drives
// that primitive the exact way Receiver.svelte#onChunkData wires it up, with
// a mocked decryptAesGcm that resolves the FIRST chunk slower than the second.
const here = dirname(fileURLToPath(import.meta.url));

// The receiver is a Svelte component (not importable in plain Node), so the
// fixture below mirrors only the onChunkData/processChunk logic with
// decryptAesGcm mocked; the ordering that matters (decrypt-await -> push ->
// blob-on-complete) is the part under test.
const { serializeTask } = await import(join(here, '..', 'src', 'utils', 'serialize.ts'));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mock decryptAesGcm: the chunk's tag byte (encrypted[0]) selects its
// latency; chunk 0 is deliberately the slowest, so its WebCrypto call would
// complete LAST without serialization.
function mockDecrypt(encrypted) {
  const index = encrypted[0];
  const payload = encrypted.subarray(1);
  const latency = index === 0 ? 40 : 2;
  return delay(latency).then(() => payload);
}

// Deterministic byte pattern: each byte encodes its position, so any
// reordering of chunks changes the assembled byte sequence.
function makeSource(size) {
  const source = new Uint8Array(size);
  for (let i = 0; i < size; i++) source[i] = (i * 7 + 3) & 0xff;
  return source;
}

function makeChunks(source, size, chunkSize) {
  const chunks = [];
  for (let off = 0; off < size; off += chunkSize) {
    const slice = source.subarray(off, Math.min(off + chunkSize, size));
    const encrypted = new Uint8Array([chunks.length, ...slice]); // tag byte + payload
    chunks.push(encrypted);
  }
  return chunks;
}

function newState(id, size) {
  return {
    receivingFiles: {
      [id]: {
        metaData: { name: 'a.bin', size, type: 'application/octet-stream', key: new Uint8Array() },
        progress: 0,
        bitrate: 0,
        startTime: 0,
        status: 'Processing',
        aesKey: 'mock-aes-key'
      }
    },
    receivingFileChunkMap: { [id]: { receivedChunks: [] } },
    receivingFileStatsMap: {
      [id]: { progress: 0, startTime: 0, nextProgressUpdate: 0, receivedSize: 0 }
    },
    chunkQueue: {}
  };
}

const ID = 'file-1';
const SIZE = 300;
const CHUNK = 128; // 3 chunks: 128 + 128 + 44

function waitSuccess(state, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (state.receivingFiles[ID].status === 'Success') {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('file never reached Success status'));
      }
    }, 1);
  });
}

// ---- Test 1: regression scenario through the serialized receiver logic ----
{
  const source = makeSource(SIZE);
  const chunks = makeChunks(source, SIZE, CHUNK);
  const state = newState(ID, SIZE);

  // Mirror of Receiver.svelte#onChunkData + #processChunk (decrypt mocked).
  const onChunkData = (id, chunk) => {
    const receivingFile = state.receivingFiles[id];
    if (!receivingFile || !state.receivingFileChunkMap[id]) {
      return;
    }
    serializeTask(state.chunkQueue, id, async () => {
      let arrayBuffer = chunk;
      if (receivingFile.aesKey) {
        arrayBuffer = await mockDecrypt(arrayBuffer);
      }
      const chunkMap = state.receivingFileChunkMap[id];
      if (!chunkMap) {
        return;
      }
      chunkMap.receivedChunks.push(arrayBuffer);
      state.receivingFileStatsMap[id].receivedSize += arrayBuffer.byteLength;
      if (state.receivingFileStatsMap[id].receivedSize >= receivingFile.metaData.size) {
        state.receivingFiles[id].blob = Buffer.concat(
          state.receivingFileChunkMap[id].receivedChunks
        );
        delete state.receivingFileChunkMap[id];
        delete state.receivingFileStatsMap[id];
        delete state.chunkQueue[id];
        state.receivingFiles[id].status = 'Success';
      }
    }).catch(() => {
      /* a failed chunk must not stall the per-file queue */
    });
  };

  // All chunks arrive synchronously in order, exactly like the data channel
  // message handler; only the mocked decryption completes out of order.
  chunks.forEach((c) => onChunkData(ID, c));
  await waitSuccess(state);

  const pushed = state.receivingFiles[ID].blob;
  assert.equal(pushed.length, SIZE, 'assembled size must equal the source size');
  assert.deepEqual(pushed, Buffer.from(source), 'assembled bytes must be in original order');
  console.log('ok - serialized chunk processing assembles the file in arrival order');
}

// ---- Test 2: control — WITHOUT serialization the mocked delay corrupts the file ----
// Proves the mock latency actually produces out-of-order completion; i.e. this
// test setup would have caught the original bug.
{
  const source = makeSource(SIZE);
  const chunks = makeChunks(source, SIZE, CHUNK);
  const state = newState(ID, SIZE);

  // Pre-fix shape: fire-and-forget async handler, await decrypt, then push.
  const onChunkDataUnserialized = (id, chunk) => {
    const receivingFile = state.receivingFiles[id];
    (async () => {
      let arrayBuffer = chunk;
      if (receivingFile.aesKey) {
        arrayBuffer = await mockDecrypt(arrayBuffer);
      }
      state.receivingFileChunkMap[id].receivedChunks.push(arrayBuffer);
      state.receivingFileStatsMap[id].receivedSize += arrayBuffer.byteLength;
    })();
  };

  chunks.forEach((c) => onChunkDataUnserialized(ID, c));
  await delay(200); // let every mocked decrypt finish

  const received = state.receivingFileChunkMap[ID].receivedChunks;
  assert.equal(received.length, chunks.length, 'all chunks were pushed');
  const assembled = Buffer.concat(received);
  const expected = Buffer.from(source);
  // The chunk payloads no longer line up with the source at their nominal
  // offsets: chunk 0's payload must have moved, which is the corruption.
  assert.ok(
    !Buffer.from(received[0]).equals(expected.subarray(0, CHUNK)),
    'without serialization the first chunk slot must hold a different chunk than chunk 0'
  );
  assert.notDeepEqual(assembled, expected, 'without serialization the bytes must be out of order');
  console.log('ok - control: unserialized async push reorders chunks (mock latency is effective)');
}

// ---- Test 3: per-key independence of the serializer ----
{
  const queue = {};
  const order = [];
  serializeTask(queue, 'a', async () => {
    order.push('a1-start');
    await delay(50);
    order.push('a1-end');
  });
  const bStartedBeforeAFinished = serializeTask(queue, 'b', async () => {
    order.push('b-start');
    await delay(5);
  });
  await Promise.all([queue.a, bStartedBeforeAFinished]);
  assert.deepEqual(
    order,
    ['a1-start', 'b-start', 'a1-end'],
    'different keys must run independently'
  );
  console.log('ok - serializer isolates per-key queues');
}

// ---- Test 4: a failed task rejects for the caller but does not stall the queue ----
{
  const queue = {};
  const results = [];
  const p1 = serializeTask(queue, 'x', () => Promise.reject(new Error('chunk corrupt')));
  const p2 = serializeTask(queue, 'x', async () => {
    results.push('second');
  });
  await assert.rejects(() => p1, /chunk corrupt/, 'caller must observe the rejection');
  await p2;
  assert.deepEqual(results, ['second'], 'subsequent task must still run after a failure');
  console.log('ok - serializer propagates rejection to caller and keeps the queue running');
}

// ---- Test 5: the fix is actually wired into the component (static guard) ----
{
  const receiverSource = readFileSync(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );
  assert.ok(
    /serializeTask\(chunkQueue, id, \(\) => processChunk\(/.test(receiverSource),
    'onChunkData must route processing through the per-file promise chain'
  );
  assert.ok(
    (receiverSource.match(/delete chunkQueue\[key\]/g) || []).length >= 2,
    'onRemove and onDeny must clean up the chunk queue entry'
  );
  assert.ok(
    /delete chunkQueue\[id\];/.test(receiverSource),
    'onAccept (re-)start and completion must release the chain entry'
  );
  console.log('ok - Receiver.svelte wires onChunkData through serializeTask with queue cleanup');
}

console.log('ok - receiver chunk order: encrypted out-of-order decrypts stay in arrival order');
