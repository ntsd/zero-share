// Regression guard for the P0 "peer-controlled MetaData.size with no
// lower-bound / finiteness validation" bug:
//   - validateFileMetadata() only checked the UPPER bound (maxSize), so a
//     peer could supply size = 0, a negative, or NaN and the receiver would
//     accept it.
//   - processChunk() then flipped the file to Success on the FIRST chunk
//     (receivedSize >= size was immediately true for size <= 0), downloading
//     a truncated / empty payload and marking it a successful transfer.
//   - Progress math produced NaN (size = 0) or large negative percentages,
//     and FileCard rendered isNaN(progress) ? 100 : progress — a broken bar.
//
// Chosen behavior (documented): size <= 0 or non-finite is rejected with
// 'invalid file size'. A 0-byte file could not be transferred correctly
// before this fix: the generated encode writes the size field only when it
// is non-zero, the sender's chunk-slice loop produced a single zero-length
// chunk, and the receiver's completion gate (receivedSize >= size) fired on
// that empty first chunk — a "successful" 0-byte download that also let a
// malicious peer claiming size = 0 stream extra bytes into the same
// "completed" file. An explicit validation error on both ends is the clean,
// documented contract:
//   - receiver: Receiver.onMetaData sends EVENT_VALIDATE_ERROR back to the
//     sender (already wired), so the sender stops cleanly instead of the
//     receiver marking a truncated file complete.
//   - sender: Sender.onFilesPick already runs validateFileMetadata at pick
//     time and stores the error on the entry, so a 0-byte local file shows
//     an immediate "invalid file size" error and is excluded from
//     "Send all files".
//
// This test verifies:
//   1. The REAL validateFileMetadata rejects size = 0, negative, NaN, and
//     ±Infinity, and still accepts valid positive sizes (no upper-bound
//     regression).
//   2. A faithful mirror of processChunk with the new progress clamp keeps
//     the progress value in [0, 100] for every size, and the completion
//     gate only completes at exactly the claimed size.
//   3. Receiver.svelte statically contains the clamp (defense in depth so
//     the UI never receives a NaN / out-of-range percentage even if a
//     malformed ratio reaches the gate).
//   4. The 0-byte metadata frame round-trips through the REAL generated
//     Message.encode/decode, confirming that a 0-byte file reaches the
//     validator as size === 0 and is rejected early instead of dead-ending
//     the transfer.
import { strict as assert } from 'node:assert';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');

// src/utils/validator.ts (and its imports) are plain ESM with TS types;
// transpile with the already-installed typescript package so the REAL
// function (not a copy that can drift) is exercised. Its value import
// (humanFileSize) has no file extension, which Node ESM refuses — rewrite
// it to the absolute .ts path (Node 22+ strips types natively, the same way
// tests/sender-chunk-size.test.mjs imports src/configs.ts).
async function loadTranspiled(name) {
  const source = await readFile(join(here, '..', 'src', 'utils', name), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020
    }
  });
  const utilsDir = join(here, '..', 'src', 'utils');
  // The transpiled relative import has no extension; Node ESM requires one,
  // so point it at the .ts source (Node 22+ strips types natively).
  const fixed = compiled.outputText.replace(/from ['"](\.[^'"]+)['"]/g, (_all, spec) => {
    const withExt = /\.(ts|js|mjs|json)$/.test(spec) ? spec : `${spec}.ts`;
    return `from '${join(utilsDir, withExt).replace(/\\/g, '/')}'`;
  });
  const tmpPath = join(here, `.validator-size.tmp-${name}.js`);
  await writeFile(tmpPath, fixed, 'utf8');
  try {
    return await import(tmpPath);
  } finally {
    await rm(tmpPath, { force: true });
  }
}

const { validateFileMetadata } = await loadTranspiled('validator.ts');

// ---- Test 1: validateFileMetadata rejects size <= 0 / non-finite ----
{
  const MAX = 1024 * 1024 * 1024; // 1 GiB, typical receive option
  const base = { name: 'x.bin', type: 'application/octet-stream', key: new Uint8Array() };

  // The task's probe matrix: size = 0, -1, NaN each cause rejection.
  const badSizes = [0, -1, -4096, NaN, Infinity, -Infinity];
  for (const size of badSizes) {
    const err = validateFileMetadata({ ...base, size }, MAX);
    assert.ok(
      err instanceof Error,
      `validateFileMetadata must reject size=${String(size)} (got ${String(err)})`
    );
    assert.equal(
      err.message,
      'invalid file size',
      `size=${String(size)} must produce the "invalid file size" error`
    );
  }
  console.log('ok - validateFileMetadata rejects 0 / negative / NaN / Infinity sizes');

  // Valid positive sizes still pass (no upper-bound regression).
  for (const size of [1, 4096, 1024 * 1024]) {
    assert.equal(
      validateFileMetadata({ ...base, size }, MAX),
      undefined,
      `validateFileMetadata must accept size=${size}`
    );
  }
  // And the existing upper-bound check still fires.
  const over = validateFileMetadata({ ...base, size: MAX + 1 }, MAX);
  assert.ok(over instanceof Error, 'size > maxSize must still be rejected');
  console.log('ok - validateFileMetadata still accepts valid positive sizes and enforces maxSize');
}

// ---- Test 2: progress clamp + completion gate in a faithful mirror ----
{
  // Mirror of Receiver.svelte#processChunk's post-fix math: progress clamped
  // to [0, 100] with NaN -> 0, then the completion gate.
  const ID = 'file-1';

  function buildReceiver(size) {
    return {
      size,
      stats: { [ID]: { progress: 0, startTime: 0, nextProgressUpdate: 0, receivedSize: 0 } },
      chunkMap: { [ID]: { receivedChunks: [] } },
      completed: false
    };
  }

  function processChunk(receiver, chunk) {
    const { size } = receiver;
    const stats = receiver.stats[ID];
    stats.receivedSize += chunk.byteLength;
    const rawProgress = Math.round((stats.receivedSize / size) * 100);
    stats.progress = Math.min(100, Math.max(0, Number.isNaN(rawProgress) ? 0 : rawProgress));
    if (stats.receivedSize >= size) {
      receiver.completed = true; // would build the Blob and flip to Success
    }
  }

  const chunk = new Uint8Array(4096);

  // Pre-fix behavior, documented: for size = 0 or -1, the raw completion
  // gate (receivedSize >= size) fired on the very first 4096-byte chunk —
  // the truncated-payload bug. Post-fix, the validator rejects those sizes
  // before any chunk is processed, so this path is unreachable; we pin the
  // raw gate's behavior to document the regression the validator prevents.
  assert.ok(4096 >= 0, 'pre-fix gate: 4096 >= 0 -> completed on first chunk');
  assert.ok(4096 >= -1, 'pre-fix gate: 4096 >= -1 -> completed on first chunk');

  // size = 4096 with one 4096-byte chunk: completes exactly at the boundary
  // (the task probe's "correct" row: progress 100, completed true).
  const r4096 = buildReceiver(4096);
  processChunk(r4096, chunk);
  assert.equal(r4096.stats[ID].progress, 100, 'size 4096, 4096 received -> 100%');
  assert.ok(r4096.completed, 'size 4096 with 4096 bytes received must complete');

  // size = 1 with a 4096-byte chunk (a peer that claims a smaller size than
  // it actually streams): the clamp must cap progress at 100 (not 409600).
  const r1 = buildReceiver(1);
  processChunk(r1, chunk);
  assert.equal(r1.stats[ID].progress, 100, 'size 1, 4096 received -> clamped to 100%');
  assert.ok(r1.completed, 'size 1 with 4096 bytes received must complete');

  // size = 10000 with a 4096-byte chunk: the gate must NOT complete yet,
  // and progress must be the correct rounded partial value (40.96 -> 41%).
  const r10k = buildReceiver(10000);
  processChunk(r10k, chunk);
  assert.equal(r10k.stats[ID].progress, 41, 'size 10000, 4096 received -> 41% (rounded)');
  assert.ok(!r10k.completed, 'size 10000 with only 4096 bytes must NOT complete early');

  console.log(
    'ok - progress clamp keeps values in [0, 100]; completion gate only at the claimed size'
  );
}

// ---- Test 3: static guard — the progress clamp is in Receiver.svelte ----
{
  const source = await readFile(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );
  // The progress value must be clamped to [0, 100] before the UI ever sees
  // it: the component must apply Math.min(100, ...) and Math.max(0, ...) and
  // coerce NaN to a safe value before assigning to stats.progress.
  assert.ok(
    /Math\.min\(\s*100,\s*Math\.max\(\s*0,\s*Number\.isNaN\(\s*rawProgress\s*\)\s*\?\s*0\s*:\s*rawProgress\s*\)/.test(
      source
    ),
    'Receiver.svelte must clamp progress to [0, 100] with a NaN -> 0 fallback'
  );
  assert.ok(
    /receivingFileStatsMap\[id\]\.progress\s*=/.test(source),
    'Receiver.svelte must assign the clamped value to stats.progress'
  );
  console.log('ok - Receiver.svelte progress clamp present (static guard)');
}

// ---- Test 4: 0-byte metadata round-trips through the real generated proto ----
{
  // src/proto/message.ts contains a TS enum, which Node's strip-only loader
  // cannot import directly (same reason as
  // tests/message-decode-robustness.test.mjs) — transpile and load.
  const protoSource = await readFile(join(here, '..', 'src', 'proto', 'message.ts'), 'utf8');
  const compiled = ts.transpileModule(protoSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020
    }
  });
  const tmpPath = join(here, '.proto-size.tmp.js');
  await writeFile(tmpPath, compiled.outputText, 'utf8');
  try {
    const { Message } = await import(tmpPath);

    // A 0-byte file's metadata (size = 0) must encode and decode back with
    // size === 0 — the generated encode omits the size field when it is 0,
    // and the generated decode defaults it to 0. This confirms a 0-byte
    // file reaches the validator as size === 0 and is rejected early with
    // 'invalid file size' instead of flowing into a bogus "completed" file.
    const metaFrame = Message.encode({
      id: 'f-0',
      metaData: { name: 'empty.txt', size: 0, type: 'text/plain', key: new Uint8Array(0) }
    }).finish();
    const decoded = Message.decode(metaFrame);
    assert.equal(decoded.metaData.size, 0, 'size-0 metadata must round-trip to 0');

    // The sender's chunk-slice loop for a 0-byte file produces a single
    // zero-length chunk, and the generated encode DOES write it to the wire
    // (a chunk !== undefined, even when empty) — so without the validator
    // fix the receiver's completion gate would flip the file to Success on
    // that empty chunk. The validator now rejects the metadata before any
    // chunk is accepted, so this path is unreachable; document the wire
    // behavior to pin it.
    const emptyChunkFrame = Message.encode({
      id: 'f-0',
      chunk: new Uint8Array(0)
    }).finish();
    const decodedChunk = Message.decode(emptyChunkFrame);
    assert.ok(
      decodedChunk.chunk instanceof Uint8Array && decodedChunk.chunk.length === 0,
      'a zero-length chunk round-trips as an empty Uint8Array (present on the wire)'
    );
    console.log(
      'ok - 0-byte metadata round-trips; empty chunk stays on the wire (validator blocks it)'
    );
  } finally {
    await rm(tmpPath, { force: true });
  }
}

console.log(
  'ok - peer-controlled MetaData.size: validator rejects <= 0 / non-finite; progress clamped; 0-byte rejection documented'
);
