import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for P0 "Resend after a chunk failure dead-ends / silently
// corrupts the re-transfer". Two concrete defects:
//
//   1. (receiver) onMetaData() unconditionally overwrote receivingFiles[id]
//      with a fresh WaitingAccept entry, then onAccept() re-created
//      receivingFileChunkMap[id] / receivingFileStatsMap[id] — but a previous
//      attempt's in-flight serializeTask continuations survive a
//      `delete chunkQueue[id]` (their .then is already scheduled), so when
//      one of them finishes decrypting it lands on the NEW attempt's chunk
//      map: receivedSize double-counts bytes the new attempt never sent, the
//      completion gate fires early, and the transfer ends as a
//      truncated/wrong-bytes Blob marked Success — or, when the stale chunk's
//      decrypt fails, the stale rejectCorruptChunk rejects the NEW attempt's
//      chunk map and dead-ends the retry the user just started.
//   2. (sender) onSend() on the Resend path left f.bitrate / f.startTime from
//      the first attempt, and the EVENT_RECEIVER_ACCEPT listener did not clear
//      a stale f.error — the reject the receiver queues when it aborts a
//      still-active attempt re-sets error on the fresh attempt's emitter and
//      dead-ends the resend.
//
// The fix fences every post-await continuation with a per-attempt generation
// counter: a re-offer of a still-active file sends EVENT_RECEIVER_REJECT,
// bumps the generation, and tears down the old chunk state BEFORE the fresh
// entry is registered; processChunk and rejectCorruptChunk drop anything
// whose captured generation no longer matches. The sender's Resend path
// resets attempt-scoped UI values and the ACCEPT listener clears stale error
// state.
//
// This test drives a faithful mirror of Receiver.svelte#onMetaData / #onAccept
// / #onChunkData / #processChunk / #rejectFile / #rejectCorruptChunk (real
// src/utils/serialize.ts, controllable mock decryption) in both the pre-fix
// shape (control — proves the corruption/dead-end) and the post-fix shape
// (no-op proof — stale chunks are dropped, the re-transfer is byte-exact),
// plus static guards that the fences are wired into both components.
const here = dirname(fileURLToPath(import.meta.url));
const { serializeTask } = await import(join(here, '..', 'src', 'utils', 'serialize.ts'));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const ID = 'file-1';
const CHUNK = 128;
// The on-wire chunk carries a 1-byte attempt tag before its payload, so a
// stale chunk that lands on a new attempt's map is byte-identifiable in the
// assembled blob. Declared size covers the tagged bytes: 3 chunks of
// 128/128/44 payload bytes -> 129/129/45 tagged -> 303.
const SIZE = 303;

function makeSource(size) {
  const source = new Uint8Array(size);
  for (let i = 0; i < size; i++) source[i] = (i * 7 + 3) & 0xff;
  return source;
}

function makeTaggedChunks(source, tag) {
  const chunks = [];
  for (let off = 0; off < source.length; off += CHUNK) {
    const payload = source.subarray(off, Math.min(off + CHUNK, source.length));
    chunks.push(new Uint8Array([tag, ...payload]));
  }
  return chunks;
}

function concatChunks(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Controllable decryption: each ciphertext's result is resolved/rejected only
// when the test says so, so an in-flight chunk can be suspended across a
// re-offer — the exact window in which the stale continuation is the hazard.
// release()/fail() may be called before or after the decrypt is awaited.
function makeDecryptor() {
  const held = new Map(); // ciphertext -> { promise, resolve, reject }
  function ensure(cipher) {
    let h = held.get(cipher);
    if (!h) {
      h = {};
      h.promise = new Promise((resolve, reject) => {
        h.resolve = resolve;
        h.reject = reject;
      });
      held.set(cipher, h);
    }
    return h;
  }
  return {
    decrypt(cipher) {
      return ensure(cipher).promise;
    },
    release(cipher, plaintext) {
      ensure(cipher).resolve(plaintext);
    },
    fail(cipher) {
      ensure(cipher).reject(new Error('GCM auth tag mismatch'));
    }
  };
}

// Faithful mirror of Receiver.svelte#onMetaData / #onAccept / #onChunkData /
// #processChunk / #rejectFile / #rejectCorruptChunk. `fenced` selects the
// post-fix generation-fence behavior (true) vs. the pre-fix shape (false):
// pre-fix onMetaData had no existing-entry handling at all, and
// processChunk/rejectCorruptChunk carried no generation check.
// (Key decryption + metadata validation are out of scope here and omitted;
// the metadata path under test otherwise runs synchronously, as in the
// component, before auto-accept.)
function buildReceiver({ name, fenced }) {
  const state = {
    receivingFiles: {},
    receivingFileChunkMap: {},
    receivingFileStatsMap: {},
    receivingFileGeneration: {},
    chunkQueue: {}
  };
  const sentEvents = [];
  const toasts = [];
  const inFlight = [];
  const decryptor = makeDecryptor();
  const autoAccept = true;

  function send(event) {
    sentEvents.push(event);
  }

  // Mirrors rejectFile: no-op once the per-file chunk map is gone.
  function rejectFile(id, receivingFile, error, toastMessage) {
    if (!state.receivingFileChunkMap[id]) {
      return;
    }
    receivingFile.error = error;
    receivingFile.status = 'Pending';
    toasts.push(toastMessage);
    send('EVENT_RECEIVER_REJECT');
    delete state.receivingFileChunkMap[id];
    delete state.receivingFileStatsMap[id];
    delete state.chunkQueue[id];
  }

  function rejectCorruptChunk(id, receivingFile, generation) {
    // Post-fix: a reject belonging to a previous attempt must not kill the
    // new attempt's chunk map.
    if (fenced && (state.receivingFileGeneration[id] ?? 0) !== generation) {
      return;
    }
    rejectFile(
      id,
      receivingFile,
      new Error('A received chunk failed to decrypt (corrupt data in transit)'),
      `${name} failed: corrupt chunk (decryption error)`
    );
  }

  async function onMetaData(metaData) {
    // Post-fix: a Success entry is terminal (stale duplicate metadata). Every
    // other existing entry is reset; when the previous attempt is still
    // actively receiving (chunk map present) the receiver aborts it with a
    // reject + visible toast; either way the generation bumps and the old
    // per-file state is torn down BEFORE the fresh entry is registered.
    if (fenced) {
      const existing = state.receivingFiles[ID];
      if (existing && existing.status === 'Success') {
        return;
      }
      if (existing) {
        if (state.receivingFileChunkMap[ID]) {
          send('EVENT_RECEIVER_REJECT');
          toasts.push(`Retrying ${metaData.name}: previous transfer aborted`);
        }
        state.receivingFileGeneration[ID] = (state.receivingFileGeneration[ID] ?? 0) + 1;
        delete state.receivingFileChunkMap[ID];
        delete state.receivingFileStatsMap[ID];
        delete state.chunkQueue[ID];
      }
    }
    state.receivingFiles[ID] = {
      metaData,
      progress: 0,
      bitrate: 0,
      startTime: 0,
      status: 'WaitingAccept',
      aesKey: 'mock'
    };
    if (autoAccept) onAccept();
  }

  function onAccept() {
    const receivingFile = state.receivingFiles[ID];
    if (!receivingFile || receivingFile.status !== 'WaitingAccept') {
      return;
    }
    if (receivingFile.error) {
      toasts.push(`Cannot accept ${receivingFile.metaData.name}: metadata failed`);
      send('EVENT_RECEIVER_REJECT');
      return;
    }
    send('EVENT_RECEIVER_ACCEPT');
    receivingFile.status = 'Processing';
    receivingFile.startTime = 1;
    state.receivingFileChunkMap[ID] = { receivedChunks: [] };
    state.receivingFileStatsMap[ID] = {
      progress: 0,
      startTime: 1,
      nextProgressUpdate: 0,
      receivedSize: 0
    };
    delete state.chunkQueue[ID];
  }

  // Mirrors onChunkData: captures this attempt's generation NOW (pre-await),
  // then enqueues onto the per-file promise chain.
  function onChunkData(cipher) {
    const receivingFile = state.receivingFiles[ID];
    if (!receivingFile || !state.receivingFileChunkMap[ID]) {
      return;
    }
    const generation = fenced ? (state.receivingFileGeneration[ID] ?? 0) : 0;
    inFlight.push(
      serializeTask(state.chunkQueue, ID, () =>
        processChunk(receivingFile, cipher, generation)
      ).catch(() => {
        rejectCorruptChunk(ID, receivingFile, generation);
      })
    );
  }

  async function processChunk(receivingFile, cipher, generation) {
    // Post-fix, pre-decrypt: a chunk enqueued by a previous attempt is
    // dropped before wasting a decrypt.
    if (fenced && (state.receivingFileGeneration[ID] ?? 0) !== generation) {
      return;
    }
    let arrayBuffer;
    try {
      arrayBuffer = await decryptor.decrypt(cipher);
    } catch {
      rejectCorruptChunk(ID, receivingFile, generation);
      return;
    }
    // The file may have been rejected/removed while this chunk was in
    // flight; the chunk map is the source of truth.
    const chunkMap = state.receivingFileChunkMap[ID];
    if (!chunkMap) {
      return;
    }
    // Post-fix, post-decrypt: a re-offer may have bumped the generation
    // while this chunk was suspended in the decrypt — drop it instead of
    // acking/pushing onto the new attempt's map.
    if (fenced && (state.receivingFileGeneration[ID] ?? 0) !== generation) {
      return;
    }
    send('EVENT_RECEIVED_CHUNK');
    chunkMap.receivedChunks.push(arrayBuffer);
    state.receivingFileStatsMap[ID].receivedSize += arrayBuffer.byteLength;
    if (state.receivingFileStatsMap[ID].receivedSize === receivingFile.metaData.size) {
      state.receivingFiles[ID].blob = concatChunks(chunkMap.receivedChunks);
      delete state.receivingFileChunkMap[ID];
      delete state.receivingFileStatsMap[ID];
      state.receivingFiles[ID].status = 'Success';
      toasts.push(`Received ${receivingFile.metaData.name}`);
      delete state.chunkQueue[ID];
    } else if (state.receivingFileStatsMap[ID].receivedSize > receivingFile.metaData.size) {
      rejectFile(
        ID,
        receivingFile,
        new Error('peer stream did not match the declared size'),
        `${receivingFile.metaData.name} rejected: stream exceeded the declared size`
      );
    }
  }

  return {
    state,
    sentEvents,
    toasts,
    decryptor,
    onMetaData,
    onAccept,
    onChunkData,
    settle() {
      return Promise.all([...inFlight]);
    },
    file() {
      return state.receivingFiles[ID];
    }
  };
}

const source = makeSource(SIZE - 3); // 300 payload bytes across 3 chunks
const meta = {
  name: 'a.bin',
  size: SIZE,
  type: 'application/octet-stream',
  key: new Uint8Array()
};

// Arms a "resend after a chunk failure" situation deterministically:
// attempt 1 (tag 1) delivers chunk 0 (acked), chunk 1 fails decryption ->
// rejectCorruptChunk tears the attempt down (Pending + error, maps gone), and
// chunk 2 is enqueued in flight — a live stale continuation exactly like the
// real component's. With `holdCorrupt` the chunk-1 decrypt stays held (the
// failed attempt is still actively receiving — chunk map present — when the
// re-offer lands: the live-abort path).
// Returns { rx, stale, fresh }: stale = attempt 1's chunk ciphertexts,
// fresh = attempt 2's chunks (all pre-released).
async function armResendAfterChunkFailure(fenced, { holdCorrupt = false } = {}) {
  const rx = buildReceiver({ name: meta.name, fenced });
  const stale = makeTaggedChunks(source, 1);
  const fresh = makeTaggedChunks(source, 2);
  for (const c of fresh) rx.decryptor.release(c, c);

  await rx.onMetaData(meta); // attempt 1 -> auto-accept -> Processing
  rx.decryptor.release(stale[0], stale[0]);
  rx.onChunkData(stale[0]); // chunk 0: immediate -> ack + push
  if (holdCorrupt) {
    // chunk 1's decrypt stays held: the failed attempt's chunk map is still
    // live when the re-offer arrives (the sender is still mid-pipeline).
    rx.onChunkData(stale[1]); // chunk 1: held, about to fail
    rx.onChunkData(stale[2]); // chunk 2: held in flight across the re-offer
  } else {
    rx.onChunkData(stale[1]); // chunk 1: held, about to fail
    rx.onChunkData(stale[2]); // chunk 2: held in flight across the re-offer
    rx.decryptor.fail(stale[1]);
    await tick(); // let chunks 0/1 settle; chunk 2's continuation is in flight
    const file = rx.file();
    assert.equal(file.status, 'Pending', 'the failed attempt must bounce to Pending');
    assert.ok(file.error instanceof Error, 'the failed attempt must carry an error');
    assert.equal(
      rx.sentEvents.filter((e) => e === 'EVENT_RECEIVER_REJECT').length,
      1,
      'the chunk failure must have sent exactly one reject'
    );
  }
  return { rx, stale, fresh };
}

const acks = (rx) => rx.sentEvents.filter((e) => e === 'EVENT_RECEIVED_CHUNK').length;
const rejects = (rx) => rx.sentEvents.filter((e) => e === 'EVENT_RECEIVER_REJECT').length;

// ---- Block 1 (pre-fix control): a stale in-flight chunk lands on the new
// chunk map — early Success with a wrong-bytes Blob and a desynced ack ----
{
  const { rx, stale, fresh } = await armResendAfterChunkFailure(false);
  // The user clicks Resend: the pre-fix onMetaData re-registers the entry and
  // auto-accepts, recreating the chunk map while attempt 1's chunk-2
  // continuation is still suspended in its decrypt.
  await rx.onMetaData(meta);
  const acksAtResend = acks(rx); // attempt 1's chunk 0 ack
  rx.onChunkData(fresh[0]);
  rx.onChunkData(fresh[1]);
  await tick(); // new attempt: 129 + 129 = 258 received, 2 acks
  // The stale chunk's decrypt now completes — pre-fix there is no generation
  // check, so it acks and pushes onto the NEW attempt's chunk map.
  rx.decryptor.release(stale[2], stale[2]);
  await rx.settle();

  const file = rx.file();
  assert.equal(file.status, 'Success', 'pre-fix: the new attempt completes early');
  assert.equal(
    acks(rx) - acksAtResend,
    3,
    'pre-fix: the new attempt is acked for a byte it never sent'
  );
  assert.ok(
    rx.toasts.includes('Received a.bin'),
    'pre-fix: the truncated file is marked Success with the success toast'
  );
  const blob = file.blob;
  const expectedFresh = concatChunks(fresh);
  assert.equal(blob.length, SIZE, 'pre-fix: blob size matches the declared size...');
  // ...but it is NOT the re-sent file: attempt 1's chunk 2 (tag byte 1) landed
  // at the tail instead of attempt 2's chunk 2 (tag byte 2).
  assert.equal(blob[258], 1, 'pre-fix: a stale in-flight chunk byte is inside the new blob');
  assert.notDeepEqual(blob, expectedFresh, 'pre-fix: the assembled bytes are corrupt');
  console.log('ok - block 1: pre-fix control completes the re-transfer early with a corrupt blob');
}

// ---- Block 2 (post-fix, already-failed re-offer): the stale continuation is
// dropped, the re-transfer is byte-exact, and the re-offer sends no reject ----
{
  const { rx, stale, fresh } = await armResendAfterChunkFailure(true);
  // chunk 2's stale continuation is suspended in its decrypt (gen 0).
  await rx.onMetaData(meta); // Resend: entry is Pending (no live chunk map)
  const acksAtResend = acks(rx); // attempt 1's chunk 0 ack
  assert.equal(
    rejects(rx),
    1,
    'post-fix: a re-offer of an already-failed file sends no second reject'
  );
  assert.ok(
    !rx.toasts.some((t) => t.startsWith('Retrying')),
    'post-fix: no abort toast for an already-dead attempt'
  );
  rx.onChunkData(fresh[0]);
  rx.onChunkData(fresh[1]);
  // The stale decrypt now completes — post-fix the generation fence drops it
  // instead of landing on the new attempt's map.
  rx.decryptor.release(stale[2], stale[2]);
  await tick();
  rx.onChunkData(fresh[2]);
  await rx.settle();

  const file = rx.file();
  assert.equal(file.status, 'Success', 'post-fix: the re-transfer completes');
  assert.equal(file.error, undefined, 'post-fix: no error on the completed file');
  assert.deepEqual(file.blob, concatChunks(fresh), 'post-fix: the blob is byte-exact');
  assert.equal(acks(rx) - acksAtResend, 3, "post-fix: exactly the new attempt's chunks are acked");
  assert.equal(rejects(rx), 1, "post-fix: still only the original chunk failure's reject");
  assert.ok(rx.toasts.includes('Received a.bin'), 'post-fix: success toast fired once');
  console.log('ok - block 2: post-fix re-send after a settled failure is byte-exact');
}

// ---- Block 3 (post-fix, live-abort re-offer): an in-flight VALID chunk
// suspended in its decrypt across the re-offer is dropped by the post-decrypt
// fence, and the abort surfaces a visible reject + toast ----
{
  const { rx, fresh, stale } = await armResendAfterChunkFailure(true, { holdCorrupt: true });
  // Let chunk 0 settle and chunk 1 START (suspending in its held decrypt)
  // BEFORE the re-offer: only then is chunk 1 genuinely in flight across the
  // re-offer, so its post-decrypt continuation is what the fences must drop.
  await tick();
  // chunk 0 is acked (129), chunks 1/2 are held; the attempt is still
  // Processing with a live chunk map when the re-offer lands.
  await rx.onMetaData(meta); // Resend -> live abort of attempt 1
  const acksAtResend = acks(rx); // attempt 1's chunk 0 ack
  assert.equal(
    rejects(rx),
    1,
    'post-fix: aborting a still-active attempt sends EVENT_RECEIVER_REJECT'
  );
  assert.ok(
    rx.toasts.includes('Retrying a.bin: previous transfer aborted'),
    'post-fix: the abort is visible (toast) to the user'
  );
  rx.onChunkData(fresh[0]);
  rx.onChunkData(fresh[1]);
  await tick(); // new attempt: 129 + 129 = 258
  // The stale chunk 1 (valid bytes) completes its decrypt across the re-offer:
  // pre-decrypt it already passed the fence, so only the POST-decrypt check
  // can keep it off the new attempt's map.
  rx.decryptor.release(stale[1], stale[1]);
  await tick(); // stale chunk 1 dropped; stale chunk 2's task starts and is dropped pre-decrypt
  assert.equal(acks(rx) - acksAtResend, 2, 'post-fix: no ack for the stale in-flight chunk');
  assert.equal(
    rx.state.receivingFileStatsMap[ID].receivedSize,
    258,
    'post-fix: the stale chunk is not double-counted'
  );
  rx.onChunkData(fresh[2]);
  await rx.settle();

  const file = rx.file();
  assert.equal(file.status, 'Success', 'post-fix: the re-transfer completes after the abort');
  assert.deepEqual(file.blob, concatChunks(fresh), 'post-fix: the blob is byte-exact');
  assert.equal(acks(rx) - acksAtResend, 3, "post-fix: exactly the new attempt's chunks are acked");
  assert.equal(rejects(rx), 1, 'post-fix: only the abort reject was sent');
  console.log('ok - block 3: post-fix live abort fences the in-flight decrypt continuation');
}

// ---- Block 4 (post-fix, live-abort + stale corrupt chunk): the stale chunk's
// failed decrypt must NOT reject the new attempt's chunk map (dead-end guard) ----
{
  const { rx, fresh, stale } = await armResendAfterChunkFailure(true, { holdCorrupt: true });
  // Same in-flight setup as block 3: chunk 1 must be suspended in its held
  // decrypt before the re-offer, so its FAILED continuation (the dead-end
  // hazard) is what the generation fence must stop.
  await tick();
  await rx.onMetaData(meta); // Resend -> live abort, new attempt's map is live
  const acksAtResend = acks(rx); // attempt 1's chunk 0 ack
  rx.onChunkData(fresh[0]);
  rx.onChunkData(fresh[1]);
  await tick();
  // The stale chunk 1 now fails its decrypt: pre-fix its rejectCorruptChunk
  // would reject the NEW attempt's chunk map and dead-end the retry.
  rx.decryptor.fail(stale[1]);
  await rx.settle();
  assert.equal(rejects(rx), 1, 'post-fix: the stale corrupt chunk sends no second reject');
  assert.ok(
    !rx.toasts.some((t) => t.includes('corrupt chunk')),
    'post-fix: no corrupt-chunk toast from the stale attempt'
  );
  assert.ok(
    rx.state.receivingFileChunkMap[ID],
    "post-fix: the new attempt's chunk map survived the stale reject"
  );
  assert.equal(rx.file().status, 'Processing', 'post-fix: the new attempt is still processing');
  rx.onChunkData(fresh[2]);
  await rx.settle();
  const file = rx.file();
  assert.equal(file.status, 'Success', 'post-fix: the re-transfer completes');
  assert.equal(acks(rx) - acksAtResend, 3, "post-fix: exactly the new attempt's chunks are acked");
  assert.deepEqual(file.blob, concatChunks(fresh), 'post-fix: the blob is byte-exact');
  console.log('ok - block 4: post-fix stale corrupt chunk cannot reject the new attempt');
}

// ---- Block 5 (live-entry no-regression): a plain single-attempt transfer
// through the fenced mirror is unchanged — the fences are no-ops ----
{
  const rx = buildReceiver({ name: meta.name, fenced: true });
  const chunks = makeTaggedChunks(source, 2);
  for (const c of chunks) rx.decryptor.release(c, c);
  await rx.onMetaData(meta);
  chunks.forEach((c) => rx.onChunkData(c));
  await rx.settle();

  const file = rx.file();
  assert.equal(file.status, 'Success', 'no-regression: single attempt completes');
  assert.deepEqual(file.blob, concatChunks(chunks), 'no-regression: blob is byte-exact');
  assert.equal(acks(rx), chunks.length, 'no-regression: every chunk is acked');
  assert.equal(rejects(rx), 0, 'no-regression: no rejects on a clean transfer');
  assert.equal(
    rx.state.receivingFileGeneration[ID] ?? 0,
    0,
    'no-regression: a single attempt never bumps the generation'
  );
  console.log('ok - block 5: fenced receiver handles a clean transfer identically');
}

// ---- Block 6 (static source guards): the fences are wired into the real
// components ----
{
  const receiverSource = readFileSync(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );
  assert.ok(
    /const receivingFileGeneration\s*:.*\}\s*=\s*\{\};/.test(receiverSource),
    'the per-file attempt-generation map must exist'
  );

  // onMetaData must fence a re-offer: Success is terminal (ignored), a
  // still-active previous attempt is aborted (reject + toast), the generation
  // is bumped, and the old per-file state is torn down — ALL of it BEFORE
  // the fresh entry is registered.
  const metaFnStart = receiverSource.indexOf('export async function onMetaData');
  const metaFnEnd = receiverSource.indexOf('export function onChannelClose');
  assert.ok(metaFnStart !== -1 && metaFnEnd > metaFnStart, 'onMetaData body must be locatable');
  const onMetaDataBody = receiverSource.slice(metaFnStart, metaFnEnd);
  assert.ok(
    /existing\.status === FileStatus\.Success/.test(onMetaDataBody),
    'onMetaData must treat a Success entry as terminal'
  );
  assert.ok(
    /receivingFileGeneration\[id\] = \(receivingFileGeneration\[id\] \?\? 0\) \+ 1/.test(
      onMetaDataBody
    ),
    'onMetaData must bump the per-file generation on a re-offer'
  );
  assert.ok(
    /EVENT_RECEIVER_REJECT/.test(onMetaDataBody),
    'onMetaData must send EVENT_RECEIVER_REJECT when aborting a live attempt'
  );
  assert.ok(
    /addToastMessage\(`Retrying /.test(onMetaDataBody),
    'onMetaData must surface the abort with a visible toast'
  );
  const bumpIdx = receiverSource.indexOf(
    'receivingFileGeneration[id] = (receivingFileGeneration[id] ?? 0) + 1'
  );
  const registerIdx = receiverSource.indexOf('receivingFiles[id] = {');
  assert.ok(
    bumpIdx !== -1 && registerIdx !== -1 && bumpIdx < registerIdx,
    'onMetaData must bump the generation and tear down BEFORE re-registering'
  );

  // processChunk must carry the generation in and check it both before and
  // after the decrypt await (the post-decrypt check is what fences a chunk
  // suspended in its decrypt across a re-offer).
  const procStart = receiverSource.indexOf('async function processChunk');
  const procEnd = receiverSource.indexOf('function rejectFile');
  assert.ok(procStart !== -1 && procEnd > procStart, 'processChunk body must be locatable');
  const processChunkBody = receiverSource.slice(procStart, procEnd);
  assert.ok(
    /chunk: Uint8Array<ArrayBuffer>,\n\s*generation: number/.test(processChunkBody),
    'processChunk must receive the attempt generation'
  );
  assert.equal(
    (processChunkBody.match(/receivingFileGeneration\[id\] \?\? 0\) !== generation/g) || []).length,
    2,
    'processChunk must fence pre-decrypt AND post-decrypt'
  );

  // rejectCorruptChunk must be generation-fenced: a stale reject must not
  // kill the new attempt's chunk map.
  const rcStart = receiverSource.indexOf('function rejectCorruptChunk');
  const rcEnd = receiverSource.indexOf('function onRemove');
  assert.ok(rcStart !== -1 && rcEnd > rcStart, 'rejectCorruptChunk body must be locatable');
  const rejectBody = receiverSource.slice(rcStart, rcEnd);
  assert.ok(
    /generation: number/.test(rejectBody),
    'rejectCorruptChunk must receive the attempt generation'
  );
  assert.ok(
    /if\s*\(\s*\(receivingFileGeneration\[id\] \?\? 0\) !== generation\)\s*\{\s*\n\s*return;/.test(
      rejectBody
    ),
    'rejectCorruptChunk must no-op for a previous attempt'
  );

  const senderSource = readFileSync(
    join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
    'utf8'
  );
  const sendStart = senderSource.indexOf('async function onSend');
  const sendEnd = senderSource.indexOf('async function sendAllFiles');
  assert.ok(sendStart !== -1 && sendEnd > sendStart, 'onSend body must be locatable');
  const onSendBody = senderSource.slice(sendStart, sendEnd);
  assert.ok(
    /sendingFile\.bitrate = 0;/.test(onSendBody) && /sendingFile\.startTime = 0;/.test(onSendBody),
    'onSend (Resend path) must reset the attempt-scoped bitrate/startTime'
  );
  assert.ok(
    /f\.error = undefined;\n\s*f\.stop = false;/.test(onSendBody),
    'the ACCEPT listener must clear stale error/stop from the aborted attempt'
  );
  assert.ok(
    /catch\s*\(err\)[\s\S]{0,300}f\.status = FileStatus\.Pending/.test(onSendBody),
    'the metadata catch must not strand the entry in WaitingAccept'
  );
  console.log('ok - block 6: source guards confirm both components wire the generation fences');
}

console.log('ok - resend after chunk failure: byte-exact re-transfer, no stale-map corruption');
