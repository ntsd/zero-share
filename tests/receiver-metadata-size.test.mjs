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
//   2. A faithful mirror of processChunk with the progress clamp + the
//     exact-match completion gate: completes only when receivedSize === the
//     claimed size, and a chunk that pushes receivedSize PAST the claim
//     (a peer claiming a smaller size than the payload it streams) now
//     rejects the file instead of completing on a truncated prefix — the
//     pre-fix mirror completed that case (size 1, 4096 received), which this
//     test inverts.
//   3. Receiver.svelte statically contains the exact (===) completion gate
//     with the overshoot reject path (EVENT_RECEIVER_REJECT + per-file
//     teardown), NOT the old >= gate, plus the progress clamp (defense in
//     depth so the UI never receives a NaN / out-of-range percentage even
//     for the single chunk between 100% and the reject).
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
  // to [0, 100] with NaN -> 0, then the exact-match completion gate. A chunk
  // that pushes receivedSize PAST the declared size now triggers the
  // overshoot reject (rejectOversizedStream: error + Pending + reject event +
  // teardown, no Blob) instead of completing on the truncated prefix.
  const ID = 'file-1';

  function buildReceiver(size) {
    return {
      size,
      stats: { [ID]: { progress: 0, startTime: 0, nextProgressUpdate: 0, receivedSize: 0 } },
      chunkMap: { [ID]: { receivedChunks: [] } },
      completed: false,
      rejected: false,
      rejectEventSent: false
    };
  }

  function processChunk(receiver, chunk) {
    const { size } = receiver;
    // Mirror of rejectOversizedStream's chunk-map guard: once the entry is
    // torn down, later chunks are dropped (component: the `if (!chunkMap) return;`
    // guard after decrypt).
    if (!receiver.chunkMap[ID] && !receiver.stats[ID]) {
      return;
    }
    const stats = receiver.stats[ID];
    stats.receivedSize += chunk.byteLength;
    const rawProgress = Math.round((stats.receivedSize / size) * 100);
    stats.progress = Math.min(100, Math.max(0, Number.isNaN(rawProgress) ? 0 : rawProgress));
    receiver.lastProgress = stats.progress; // UI value as of this chunk (survives teardown)
    if (stats.receivedSize === size) {
      receiver.completed = true; // would build the Blob and flip to Success
    } else if (stats.receivedSize > size) {
      receiver.rejected = true; // would mark error + Pending, toast
      receiver.rejectEventSent = true; // would send EVENT_RECEIVER_REJECT
      delete receiver.chunkMap[ID];
      delete receiver.stats[ID];
    }
  }

  const chunk = new Uint8Array(4096);

  // Pre-fix behavior, documented (historical): for size = 0 or -1, the raw
  // completion gate (receivedSize >= size) fired on the very first 4096-byte
  // chunk — the truncated-payload bug. Post-fix, the validator rejects those
  // sizes before any chunk is processed, so this path is unreachable; we pin
  // the raw gate's behavior to document the regression the validator prevents.
  assert.ok(4096 >= 0, 'pre-fix gate: 4096 >= 0 -> completed on first chunk');
  assert.ok(4096 >= -1, 'pre-fix gate: 4096 >= -1 -> completed on first chunk');

  // size = 4096 with one 4096-byte chunk: completes exactly at the boundary
  // (the task probe's "correct" row: progress 100, completed true).
  const r4096 = buildReceiver(4096);
  processChunk(r4096, chunk);
  assert.equal(r4096.stats[ID].progress, 100, 'size 4096, 4096 received -> 100%');
  assert.ok(r4096.completed, 'size 4096 with 4096 bytes received must complete');

  // size = 1 with a 4096-byte chunk (a peer that claims a smaller size than
  // it actually streams): the clamp must cap progress at 100 (not 409600),
  // and the gate must REJECT instead of completing — the pre-fix mirror
  // completed here (truncated 1-byte Success, tail silently dropped).
  const r1 = buildReceiver(1);
  processChunk(r1, chunk);
  assert.equal(r1.lastProgress, 100, 'size 1, 4096 received -> clamped to 100%');
  assert.ok(!r1.completed, 'size 1 with 4096 bytes received must NOT complete (overshoot)');
  assert.ok(r1.rejected, 'size 1 with 4096 bytes received must reject the stream');
  assert.ok(r1.rejectEventSent, 'the overshoot reject must send EVENT_RECEIVER_REJECT');

  // Multi-chunk exact match still completes at the last chunk: 3 x 2048 = 6144,
  // no early completion on the first two partial chunks.
  const rMulti = buildReceiver(6144);
  processChunk(rMulti, chunk.subarray(0, 2048));
  assert.ok(!rMulti.completed, 'multi-chunk: first partial chunk must not complete');
  processChunk(rMulti, chunk.subarray(0, 2048));
  assert.ok(!rMulti.completed, 'multi-chunk: second partial chunk must not complete');
  processChunk(rMulti, chunk.subarray(0, 2048));
  assert.ok(rMulti.completed, 'multi-chunk: exact-match at the last chunk must complete');
  assert.ok(!rMulti.rejected, 'multi-chunk: no reject on an exact-match stream');

  // Overshoot on a multi-chunk stream: 2 x 2048 = 4096 against a declared
  // 3000 — the second chunk pushes receivedSize past the claim, so the file
  // is rejected (not completed, no Blob) and any later chunk is dropped by
  // the torn-down chunk map.
  const rMultiOver = buildReceiver(3000);
  processChunk(rMultiOver, chunk.subarray(0, 2048));
  assert.ok(
    !rMultiOver.completed && !rMultiOver.rejected,
    'partial chunk below the claim is accepted'
  );
  processChunk(rMultiOver, chunk.subarray(0, 2048));
  assert.ok(!rMultiOver.completed, 'overshoot at the second chunk must NOT complete');
  assert.ok(rMultiOver.rejected, 'overshoot at the second chunk must reject');
  processChunk(rMultiOver, chunk);
  assert.ok(!rMultiOver.completed, 'chunks after the reject are dropped, never complete');

  // size = 10000 with a 4096-byte chunk: the gate must NOT complete yet,
  // and progress must be the correct rounded partial value (40.96 -> 41%).
  const r10k = buildReceiver(10000);
  processChunk(r10k, chunk);
  assert.equal(r10k.stats[ID].progress, 41, 'size 10000, 4096 received -> 41% (rounded)');
  assert.ok(!r10k.completed, 'size 10000 with only 4096 bytes must NOT complete early');

  console.log(
    'ok - progress clamp keeps values in [0, 100]; exact-match gate completes only at the claimed size; overshoot rejects'
  );
}

// ---- Test 3: static guard — exact-match completion gate + overshoot reject ----
{
  const source = await readFile(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );

  // Isolate the processChunk() function body via brace matching so the gate
  // assertions cannot be satisfied by a match elsewhere in the component.
  const start = source.search(/function\s+processChunk\s*\(/);
  assert.ok(start !== -1, 'processChunk() must exist');
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let bodyEnd = -1;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        bodyEnd = i + 1;
        break;
      }
    }
  }
  assert.ok(bodyEnd !== -1, 'processChunk(): unbalanced braces');
  const body = source.slice(braceStart, bodyEnd);

  // The completion gate must be an EXACT byte-count match (===). The old
  // `>=` gate completed on the first chunk that reached the claimed size,
  // marking a truncated prefix as Success when the peer streamed more.
  assert.ok(
    /receivingFileStatsMap\[id\]\.receivedSize\s*===\s*receivingFile\.metaData\.size/.test(body),
    'processChunk must complete on receivedSize === metaData.size (exact match)'
  );
  assert.ok(
    !/receivingFileStatsMap\[id\]\.receivedSize\s*>=\s*receivingFile\.metaData\.size/.test(body),
    'processChunk must not use the old >= completion gate'
  );

  // The overshoot reject path must exist: a chunk that pushes receivedSize
  // past the declared size rejects the file (error + Pending + reject event +
  // teardown) instead of completing. The component may inline it or call a
  // helper; either way the reject event must be wired to the > branch and the
  // per-file state torn down.
  const rejectMarker = /rejectOversizedStream|ReceiveEvent\.EVENT_RECEIVER_REJECT/.test(body);
  assert.ok(
    rejectMarker,
    'processChunk must wire an overshoot reject (helper or EVENT_RECEIVER_REJECT)'
  );
  assert.ok(
    /receivingFileStatsMap\[id\]\.receivedSize\s*>\s*receivingFile\.metaData\.size/.test(body),
    'processChunk must detect the overshoot (receivedSize > declared size)'
  );
  const rejectBody = body.includes('rejectOversizedStream')
    ? (() => {
        const rStart = source.search(/function\s+rejectOversizedStream\s*\(/);
        assert.ok(rStart !== -1, 'rejectOversizedStream() helper must exist');
        const rBrace = source.indexOf('{', rStart);
        let rDepth = 0;
        let rEnd = -1;
        for (let i = rBrace; i < source.length; i++) {
          if (source[i] === '{') rDepth++;
          else if (source[i] === '}') {
            rDepth--;
            if (rDepth === 0) {
              rEnd = i + 1;
              break;
            }
          }
        }
        assert.ok(rEnd !== -1, 'rejectOversizedStream(): unbalanced braces');
        const ownBody = source.slice(rBrace, rEnd);
        // rejectOversizedStream may delegate its teardown to a shared
        // rejectFile() helper — follow the delegation so the assertions
        // below land on the body that actually performs it.
        if (/rejectFile\(/.test(ownBody)) {
          const fStart = source.search(/function\s+rejectFile\s*\(/);
          assert.ok(fStart !== -1, 'rejectFile() shared teardown helper must exist');
          assert.ok(
            /rejectFile\s*\(/.test(ownBody),
            'rejectOversizedStream must delegate to the shared rejectFile() helper'
          );
          const fBrace = source.indexOf('{', fStart);
          let fDepth = 0;
          let fEnd = -1;
          for (let i = fBrace; i < source.length; i++) {
            if (source[i] === '{') fDepth++;
            else if (source[i] === '}') {
              fDepth--;
              if (fDepth === 0) {
                fEnd = i + 1;
                break;
              }
            }
          }
          assert.ok(fEnd !== -1, 'rejectFile(): unbalanced braces');
          return source.slice(fBrace, fEnd);
        }
        return ownBody;
      })()
    : body;
  assert.ok(
    rejectBody.includes('EVENT_RECEIVER_REJECT'),
    'the overshoot reject must send EVENT_RECEIVER_REJECT so the sender bounces to Pending'
  );
  assert.ok(
    /receivingFile\.status\s*=\s*FileStatus\.Pending/.test(rejectBody),
    'the overshoot reject must bounce the file back to Pending'
  );
  assert.ok(
    rejectBody.includes('delete receivingFileChunkMap[id]') &&
      rejectBody.includes('delete receivingFileStatsMap[id]') &&
      rejectBody.includes('delete chunkQueue[id]'),
    'the overshoot reject must tear down the per-file chunk/stats/queue state'
  );

  // The progress clamp remains (defense in depth on top of the exact gate).
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
  console.log(
    'ok - Receiver.svelte completion gate is exact (===), overshoot rejects; progress clamp present'
  );
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
