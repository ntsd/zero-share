import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for P0 "receiver hangs forever when an encrypted chunk
// fails to decrypt":
//   1. processChunk() sent the EVENT_RECEIVED_CHUNK ack to the sender BEFORE
//      it decrypted, so a corrupt chunk advanced the sender even though its
//      decrypted bytes were never usable.
//   2. onChunkData() enqueued via serializeTask(...).catch(() => {}), which
//      silently swallowed a rejected decrypt, so the file's receivedSize could
//      never reach metaData.size and it sat in Processing forever.
//   3. The sender (one-shot streaming, no retransmission) then walked to the
//      end and reported success while the receiver's byte count stayed short.
//
// The fix: decrypt FIRST (in a try/catch), and only ack AFTER a successful
// decrypt; on a decrypt failure call rejectCorruptChunk(), which marks the
// file errored, bounces it back to Pending, and sends EVENT_RECEIVER_REJECT so
// the sender stops cleanly. This test drives that exact logic with REAL
// WebCrypto AES-GCM so the corrupt chunk genuinely fails authentication, plus
// a static guard that the ack is ordered after the decrypt in the component.
const here = dirname(fileURLToPath(import.meta.url));

// The receiver is a Svelte component (not importable in plain Node), so the
// fixture below mirrors only the onChunkData/processChunk/rejectCorruptChunk
// logic; decryption uses the REAL src/utils/crypto.ts so the GCM auth failure
// is authentic, and serializeTask is the real primitive the component wires up.
const { serializeTask } = await import(join(here, '..', 'src', 'utils', 'serialize.ts'));
const { generateAesKey, encryptAesGcm, decryptAesGcm } = await import(
  join(here, '..', 'src', 'utils', 'crypto.ts')
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isEncrypt = true;

// Faithful mirror of Receiver.svelte#onChunkData + #processChunk +
// #rejectCorruptChunk (post-fix ordering: decrypt -> guard -> ack -> push).
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
  const sentEvents = []; // { id, receiveEvent }
  const toasts = [];
  const dataChannel = { send() {} };

  function rejectCorruptChunk(id, receivingFile) {
    if (!state.receivingFileChunkMap[id]) {
      return;
    }
    receivingFile.error = new Error('A received chunk failed to decrypt (corrupt data in transit)');
    receivingFile.status = 'Pending';
    toasts.push(`${receivingFile.metaData.name} failed: corrupt chunk (decryption error)`);
    dataChannel.send();
    sentEvents.push({ id, receiveEvent: 'EVENT_RECEIVER_REJECT' });
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
    sentEvents.push({ id, receiveEvent: 'EVENT_RECEIVED_CHUNK' });
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

  // Mirrors onChunkData; captures the returned promise so the test can await
  // the chain to settle (the component fire-and-forgets via .catch).
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

  async function settle() {
    await Promise.all(inFlight);
  }

  return { ID, state, sentEvents, toasts, onChunkData, settle };
}

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

// ---- Test 1: real AES-GCM, one corrupt chunk -> file surfaces an error, not stuck ----
{
  const ID = 'file-1';
  const SIZE = 300;
  const CHUNK = 128; // 3 chunks: 128 + 128 + 44
  const source = makeSource(SIZE);
  const plaintextChunks = chunksFor(source, CHUNK);

  // Encrypt all chunks with a real AES-256 key. pc is a subarray VIEW, so pass
  // a detached copy (pc.slice().buffer) — pc.buffer would be the whole source.
  const aesKey = await generateAesKey();
  const encrypted = [];
  for (const pc of plaintextChunks) {
    encrypted.push(await encryptAesGcm(aesKey, pc.slice().buffer));
  }

  // Corrupt the middle chunk: flip a ciphertext byte (past the 12-byte IV) so
  // the GCM auth tag no longer matches.
  const corruptIndex = 1;
  encrypted[corruptIndex][40] ^= 0xff;

  const receiver = buildReceiver({ size: SIZE, name: 'a.bin' });
  receiver.state.receivingFiles[ID].aesKey = aesKey;

  // Drive onChunkData with all three chunks, exactly like the data channel
  // message handler (synchronous, in arrival order).
  encrypted.forEach((c) => receiver.onChunkData(ID, c));
  await receiver.settle();

  const file = receiver.state.receivingFiles[ID];
  assert.notEqual(
    file.status,
    'Processing',
    'the file must not remain stuck in Processing after a decrypt failure'
  );
  assert.equal(file.status, 'Pending', 'the failed file must bounce back to Pending');
  assert.ok(file.error instanceof Error, 'the failed file must carry an error');
  assert.match(
    file.error.message,
    /decrypt|corrupt/i,
    'the error must describe the decrypt failure'
  );

  // The receiver must have sent exactly one EVENT_RECEIVER_REJECT so the
  // sender stops cleanly instead of walking to the end and reporting success.
  const rejects = receiver.sentEvents.filter((e) => e.receiveEvent === 'EVENT_RECEIVER_REJECT');
  assert.equal(
    rejects.length,
    1,
    'a single corrupt chunk must produce exactly one EVENT_RECEIVER_REJECT'
  );

  // The corrupt chunk (and everything after it) must NOT be acked: only chunk 0
  // decrypted successfully, so exactly one EVENT_RECEIVED_CHUNK ack is allowed.
  const acks = receiver.sentEvents.filter((e) => e.receiveEvent === 'EVENT_RECEIVED_CHUNK');
  assert.equal(
    acks.length,
    1,
    'only the successfully-decrypted chunk(s) may be acked; the corrupt one must not advance the sender'
  );

  // The corrupt chunk's bytes must NOT have been pushed (receivedSize stays short).
  const chunkMap = receiver.state.receivingFileChunkMap[ID];
  if (chunkMap) {
    assert.equal(
      chunkMap.receivedChunks.length,
      1,
      'only the successfully-decrypted chunk may be pushed into the chunk map'
    );
  }
  const stats = receiver.state.receivingFileStatsMap[ID];
  if (stats) {
    assert.equal(stats.receivedSize, CHUNK, 'receivedSize must reflect only the good chunk');
  }
  assert.ok(receiver.toasts.length >= 1, 'the failure must surface a toast');
  console.log(
    'ok - real AES-GCM corrupt chunk -> file errored + Pending + single reject, not stuck'
  );
}

// ---- Test 2: control — a fully intact stream still completes (no false reject) ----
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

  const receiver = buildReceiver({ size: SIZE, name: 'ok.bin' });
  receiver.state.receivingFiles[receiver.ID].aesKey = aesKey;
  encrypted.forEach((c) => receiver.onChunkData(receiver.ID, c));
  await receiver.settle();

  const file = receiver.state.receivingFiles[receiver.ID];
  assert.equal(file.status, 'Success', 'an intact encrypted stream must still complete');
  assert.equal(file.error, undefined, 'no error should be set on a clean stream');
  assert.equal(
    receiver.sentEvents.filter((e) => e.receiveEvent === 'EVENT_RECEIVER_REJECT').length,
    0,
    'a clean stream must never send EVENT_RECEIVER_REJECT'
  );
  assert.equal(
    receiver.sentEvents.filter((e) => e.receiveEvent === 'EVENT_RECEIVED_CHUNK').length,
    plaintextChunks.length,
    'every successfully-decrypted chunk must be acked'
  );
  console.log('ok - intact encrypted stream completes without a false reject');
}

// ---- Test 3: static guard — the component acks ONLY after decryption ----
{
  const receiverSource = readFileSync(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );

  // Extract the processChunk() body and assert the decrypt happens strictly
  // before the ack is sent (the pre-fix ordering acked before decrypting).
  const start = receiverSource.search(/function\s+processChunk\s*\(/);
  assert.ok(start !== -1, 'processChunk() must exist');
  const braceStart = receiverSource.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < receiverSource.length; i++) {
    if (receiverSource[i] === '{') depth++;
    else if (receiverSource[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end !== -1, 'processChunk(): unbalanced braces');
  const body = receiverSource.slice(braceStart, end);

  const decryptIdx = body.indexOf('decryptAesGcm');
  const ackIdx = body.indexOf('EVENT_RECEIVED_CHUNK');
  assert.ok(decryptIdx !== -1, 'processChunk must decrypt via decryptAesGcm');
  assert.ok(ackIdx !== -1, 'processChunk must send the EVENT_RECEIVED_CHUNK ack');
  assert.ok(
    decryptIdx < ackIdx,
    'the decrypt must be ordered strictly before the EVENT_RECEIVED_CHUNK ack (no ack-before-decrypt)'
  );

  // The decrypt failure must be handled and routed to the reject handler
  // instead of being swallowed by a bare catch.
  const rejectFn = receiverSource.search(/function\s+rejectCorruptChunk\s*\(/);
  assert.ok(rejectFn !== -1, 'rejectCorruptChunk() must exist');
  assert.ok(
    /rejectCorruptChunk\(\s*id,\s*receivingFile\s*\)/.test(body),
    'processChunk must call rejectCorruptChunk on a decrypt failure'
  );
  // rejectCorruptChunk must surface the error and stop the sender.
  assert.ok(/receivingFile\.status\s*=\s*FileStatus\.Pending/.test(receiverSource));
  assert.ok(
    receiverSource.includes('EVENT_RECEIVER_REJECT'),
    'the receiver must send EVENT_RECEIVER_REJECT on a corrupt chunk'
  );
  console.log(
    'ok - component source: ack ordered after decrypt; decrypt failure routes to rejectCorruptChunk + reject'
  );
}

console.log(
  'ok - receiver chunk failure: corrupt encrypted chunk no longer leaves the file stuck in Processing'
);
