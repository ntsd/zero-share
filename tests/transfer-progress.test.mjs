// Runtime guard for the deduplicated per-file progress + bitrate update
// (src/utils/transferProgress.ts). The block was copy-pasted in lockstep in
// Sender.svelte (sendNextChunk) and Receiver.svelte (processChunk); any
// future change to the progress/bitrate semantics must now land in exactly
// one place. These tests exercise updateTransferProgress() directly —
// progress math, the 3%-step UI throttle, the zero-elapsed bitrate floor
// (#134), and the progress clamp — pinning the helper's actual behaviour
// rather than its source shape (the shape is pinned by
// tests/bitrate-zero-elapsed-guard.test.mjs and
// tests/sender-bitrate-clock.test.mjs).
//
// updateTransferProgress has no enums or Svelte syntax, but it carries a local
// value import (`../configs`, no file extension) that Node ESM refuses to
// resolve directly. Transpile the real source with the already-installed
// typescript package and rewrite that import to the absolute .ts path, so the
// REAL function (not a copy that can drift) is exercised — the same convention
// as tests/receiver-metadata-size.test.mjs (loadTranspiled).
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');

async function loadTranspiled(name, fromDir) {
  const source = await readFile(join(here, '..', 'src', fromDir, name), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020
    }
  });
  // Point each relative import at its absolute .ts source: Node ESM requires
  // an explicit extension, and Node 22+ strips types natively.
  const srcDir = join(here, '..', 'src', fromDir);
  const fixed = compiled.outputText.replace(/from ['"](\.[^'"]+)['"]/g, (_all, spec) => {
    const withExt = /\.(ts|js|mjs|json)$/.test(spec) ? spec : `${spec}.ts`;
    // Resolve the relative spec against the source file's own directory.
    const resolved = join(dirname(join(srcDir, name)), withExt);
    return `from '${resolved.replace(/\\/g, '/')}'`;
  });
  const tmpPath = join(here, `.transfer-progress.tmp-${name}.js`);
  await writeFile(tmpPath, fixed, 'utf8');
  try {
    return await import(tmpPath);
  } finally {
    await rm(tmpPath, { force: true });
  }
}

const { updateTransferProgress } = await loadTranspiled('transferProgress.ts', 'utils');

// PROGRESS_UPDATE_UI_STEP is the 3% throttle step (src/configs.ts).
const STEP = 3;

// Freeze Date.now so elapsed-time assertions are deterministic. The floor is
// `Math.max(1, Date.now() - startTime)`; returning a fixed value makes the
// elapsed term a known constant.
function withFrozenNow(ms, fn) {
  const realNow = Date.now;
  Date.now = () => ms;
  try {
    fn();
  } finally {
    Date.now = realNow;
  }
}

// ---- Test 1: progress math + the UI-update gate (below threshold) ----
{
  const stats = { progress: 0, startTime: 0, nextProgressUpdate: 0 };
  const target = {};
  // progress starts at 0; nextProgressUpdate is 0, so 0 >= 0 fires the first
  // UI update immediately (matches the components: the first chunk always
  // pushes a progress + bitrate update).
  withFrozenNow(1000, () => updateTransferProgress(stats, 32768, 100000, target));
  assert.equal(stats.progress, 33, '32768/100000 rounds to 33%');
  assert.equal(target.progress, 33, 'the UI progress must be written on the first tick');
  assert.ok(Number.isFinite(target.bitrate), 'the bitrate must be a finite number');
  assert.equal(stats.nextProgressUpdate, STEP, 'the throttle must advance by one step');
  console.log('ok - first tick: progress + bitrate written, throttle advanced by one step');
}

// ---- Test 2: below the next threshold no UI write happens ----
{
  const stats = { progress: 0, startTime: 0, nextProgressUpdate: 50 };
  const target = { progress: -1, bitrate: -1 };
  withFrozenNow(1000, () => updateTransferProgress(stats, 30000, 100000, target));
  assert.equal(stats.progress, 30, 'progress still computed even when the gate is closed');
  assert.equal(target.progress, -1, 'below threshold: the UI progress must NOT be written');
  assert.equal(target.bitrate, -1, 'below threshold: the UI bitrate must NOT be written');
  assert.equal(stats.nextProgressUpdate, 50, 'below threshold: the throttle must not advance');
  console.log('ok - below threshold: progress computed, no UI write, throttle held');
}

// ---- Test 3: the UI update fires at the threshold, re-arms, then holds ----
{
  const stats = { progress: 0, startTime: 0, nextProgressUpdate: 30 };
  const target = {};
  withFrozenNow(1000, () => {
    // 30% crosses the 30 threshold -> fires; throttle re-arms to 33.
    updateTransferProgress(stats, 30000, 100000, target);
    assert.equal(target.progress, 30, 'at threshold the UI progress must be written');
    assert.equal(
      stats.nextProgressUpdate,
      30 + STEP,
      'after firing the throttle re-arms to 30 + step'
    );
    // 31% is now BELOW the re-armed 33 threshold -> no UI write, throttle held.
    const target2 = { progress: -1 };
    updateTransferProgress(stats, 31000, 100000, target2);
    assert.equal(stats.progress, 31, 'progress advanced to 31%');
    assert.equal(target2.progress, -1, '31% is below the re-armed 33 threshold: no UI write');
    assert.equal(
      stats.nextProgressUpdate,
      30 + STEP,
      'the throttle must hold until the new threshold is crossed'
    );
  });
  console.log(
    'ok - threshold: fires at threshold, re-arms by one step, holds below the new threshold'
  );
}

// ---- Test 4: the throttle step clamps at 100 ----
{
  const stats = { progress: 0, startTime: 0, nextProgressUpdate: 99 };
  const target = {};
  withFrozenNow(1000, () => {
    // 99 -> crosses 99 -> fires, nextProgressUpdate = 99 + 3 = 102.
    updateTransferProgress(stats, 100000, 100000, target);
    assert.equal(stats.progress, 100, 'full transfer rounds to 100%');
    assert.equal(
      stats.nextProgressUpdate,
      100,
      'the throttle must clamp at 100, not overshoot to 102'
    );
  });
  console.log('ok - throttle: nextProgressUpdate clamps at 100');
}

// ---- Test 5: the zero-elapsed bitrate floor (#134) ----
// A small file whose accept and first progress update share a millisecond
// makes the raw elapsed time 0 -> bytes / 0 = Infinity. The floor keeps it
// finite. We exercise this by making the clock read AHEAD of startTime, so
// Date.now() - startTime is negative and Math.max(1, negative) === 1.
{
  // startTime in the FUTURE relative to the frozen now: elapsed = now - start
  // is negative, and the floor must coerce it to a 1 ms minimum.
  const startMs = 1_000_000;
  const stats = { progress: 0, startTime: startMs + 500, nextProgressUpdate: 0 };
  const target = {};
  withFrozenNow(startMs, () => updateTransferProgress(stats, 32768, 100000, target));
  assert.ok(
    Number.isFinite(target.bitrate),
    'the bitrate must be finite when accept and the first update share (or precede) a millisecond'
  );
  // With the 1 ms floor, 32768 bytes / 0.001 s = 32_768_000 B/s.
  assert.equal(target.bitrate, 32768 / 0.001, 'the bitrate must divide by the 1 ms floor');
  console.log('ok - zero-elapsed floor: bitrate is finite at a same-millisecond accept');
}

// ---- Test 6: the bitrate scales with real elapsed time ----
{
  const startMs = 0;
  const stats = { progress: 0, startTime: startMs, nextProgressUpdate: 0 };
  const target = {};
  // 2 seconds of elapsed time for 200000 bytes -> 100000 B/s.
  withFrozenNow(startMs + 2000, () => updateTransferProgress(stats, 200000, 1000000, target));
  assert.equal(target.bitrate, 100000, 'the bitrate must be bytes / elapsed-seconds');
  assert.equal(stats.startTime, startMs, 'the helper must NOT mutate the attempt clock');
  console.log('ok - bitrate: scales with real elapsed time, clock untouched');
}

// ---- Test 7: progress clamp (defence in depth against an oversize peer) ----
// A peer that claims a size smaller than the payload it streams pushes the
// ratio past 100. The clamp keeps the UI value renderable (100) until the
// exact-match completion gate in the component rejects the stream.
{
  const stats = { progress: 0, startTime: 0, nextProgressUpdate: 0 };
  const target = {};
  withFrozenNow(1000, () => updateTransferProgress(stats, 150000, 100000, target));
  assert.equal(stats.progress, 100, 'overshoot: progress must clamp to 100');
  assert.equal(target.progress, 100, 'overshoot: the UI progress must be clamped to 100');
  assert.ok(Number.isFinite(target.bitrate), 'overshoot: the bitrate must stay finite');
  console.log('ok - clamp: an oversize peer clamps progress to 100 instead of >100');
}

// ---- Test 8: NaN totalBytes (peer-claimed size of 0) -> progress 0 ----
// A 0-byte declared size makes sentBytes / totalBytes = NaN. The clamp's
// Number.isNaN fallback coerces progress to 0 rather than handing the UI a
// NaN it cannot render. (The validator rejects size <= 0 up front; this is
// the last-line guard inside the helper.)
{
  const stats = { progress: 0, startTime: 0, nextProgressUpdate: 0 };
  const target = {};
  withFrozenNow(1000, () => updateTransferProgress(stats, 0, 0, target));
  assert.equal(stats.progress, 0, '0/0 is NaN; the helper must coerce progress to 0');
  console.log('ok - clamp: a 0-byte declared size coerces NaN progress to 0');
}

console.log(
  'ok - transfer progress: helper matches the sender/receiver semantics (progress, throttle, floor, clamp)'
);
