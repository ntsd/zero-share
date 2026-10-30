// Regression guard for the P0 "humanFileSize() renders 'undefined' for
// fractional byte sizes in (0, 1)" bug:
//
//   const i = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
//
// For any size in (0, 1), Math.log(size) < 0, so Math.floor(...) === -1 and
// the upper-bound clamp (Math.min(units.length - 1, ...)) does nothing —
// units[-1] is undefined and the label becomes "512.00 undefined"
// (size = 0.5) or "1013.76 undefined" (size = 0.99). The earlier fix
// (zf-zs-380c9852) guarded size <= 0 / non-finite ('0 B') and clamped the
// UPPER end only; the lower bound was left out of scope.
//
// Reachability: metaData.size is peer-controlled and flows straight into
// FileCard.svelte's "Size:" line (humanFileSize(fileDetail.metaData.size)).
// The shared validator previously only rejected size <= 0 / non-finite, so
// a fractional size like 0.5 passed and additionally dead-ended the
// receiver's exact-match completion gate (receivedSize === metaData.size can
// never hold when the target is fractional — receivedSize is a sum of
// integer chunk byte lengths).
//
// Chosen behavior (documented):
//   - humanFileSize clamps the unit index on BOTH ends: every finite
//     positive value maps to a valid unit. 0.5 -> "0.50 B", 0.99 -> "0.99 B";
//     all size >= 1 behavior is byte-identical to the pre-fix function.
//   - validateFileMetadata additionally rejects non-integer sizes
//     (!Number.isInteger) so a fractional peer-controlled size is bounced
//     with an explicit 'invalid file size' instead of being accepted and
//     dead-ending the transfer.
//
// This test verifies:
//   1. The REAL humanFileSize (transpiled, not a copy that can drift):
//      (0, 1) fractional cases, the existing 0 / negative / non-finite
//      guard, the exact acceptance-criteria values, the upper-bound clamp,
//      and a sweep asserting "undefined" never appears in any output.
//   2. The REAL validateFileMetadata rejects fractional sizes with
//      'invalid file size' while still accepting integer sizes and still
//      enforcing the maxSize upper bound.
//   3. FileCard.svelte statically wires humanFileSize to metaData.size at
//      the render site (behavior reference — the label must come from the
//      clamped helper, not an inline reimplementation).
import { strict as assert } from 'node:assert';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');

// src/utils/*.ts are plain ESM with TS types; transpile with the
// already-installed typescript package so the REAL function (not a copy
// that can drift) is exercised. Same pattern as
// tests/receiver-metadata-size.test.mjs: rewrite the extensionless relative
// value import to the absolute .ts path (Node 22+ strips types natively).
async function loadTranspiled(name) {
  const source = await readFile(join(here, '..', 'src', 'utils', name), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020
    }
  });
  const utilsDir = join(here, '..', 'src', 'utils');
  const fixed = compiled.outputText.replace(/from ['"](\.[^'"]+)['"]/g, (_all, spec) => {
    const withExt = /\.(ts|js|mjs|json)$/.test(spec) ? spec : `${spec}.ts`;
    return `from '${join(utilsDir, withExt).replace(/\\/g, '/')}'`;
  });
  const tmpPath = join(here, `.human-file-size.tmp-${name}.js`);
  await writeFile(tmpPath, fixed, 'utf8');
  try {
    return await import(tmpPath);
  } finally {
    await rm(tmpPath, { force: true });
  }
}

const { humanFileSize } = await loadTranspiled('humanFileSize.ts');
const { validateFileMetadata } = await loadTranspiled('validator.ts');

// ---- Test 1: fractional sizes in (0, 1) render a valid unit, never "undefined" ----
{
  // The task's acceptance criteria, verbatim.
  assert.equal(humanFileSize(0.5), '0.50 B', 'humanFileSize(0.5) must be "0.50 B"');
  assert.equal(humanFileSize(0.99), '0.99 B', 'humanFileSize(0.99) must be "0.99 B"');

  // The pre-fix function produced the literal string "undefined" in the unit
  // slot for every input in (0, 1); none of these may contain it.
  for (const size of [0.0001, 0.001, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]) {
    const out = humanFileSize(size);
    assert.ok(
      !out.includes('undefined'),
      `humanFileSize(${size}) must never contain "undefined" (got ${JSON.stringify(out)})`
    );
    assert.ok(
      /^\d+\.\d{2} B$/.test(out),
      `humanFileSize(${size}) must render bytes with the "B" unit (got ${JSON.stringify(out)})`
    );
  }
  assert.equal(
    humanFileSize(0.0001),
    '0.00 B',
    'sub-millibyte values round to "0.00 B" (still a valid unit)'
  );
  console.log('ok - humanFileSize(0,1) fractional sizes render a valid unit, never "undefined"');
}

// ---- Test 2: existing guards and size >= 1 behavior are preserved ----
{
  // The size <= 0 / non-finite guard from zf-zs-380c9852 is untouched.
  for (const size of [0, -1, -1024, NaN, Infinity, -Infinity]) {
    assert.equal(
      humanFileSize(size),
      '0 B',
      `humanFileSize(${String(size)}) must still be "0 B" (existing guard)`
    );
  }

  // Exact acceptance values and unit-boundary behavior for size >= 1.
  assert.equal(humanFileSize(1), '1.00 B');
  assert.equal(humanFileSize(1024), '1.00 KB');
  assert.equal(humanFileSize(1024 * 1024), '1.00 MB');
  assert.equal(humanFileSize(1024 * 1024 * 1024), '1.00 GB');
  assert.equal(humanFileSize(5 * 1024), '5.00 KB');

  console.log(
    'ok - humanFileSize 0 / negative / non-finite guard and size >= 1 behavior preserved'
  );
}

// ---- Test 3: upper-bound clamp preserved, and a full sweep never emits "undefined" ----
{
  // 5e18 is past the top of the PB slot: the upper clamp pins the index to
  // the last unit. The pre-fix and post-fix functions agree here (the upper
  // clamp predates this fix) — pin the exact value so a drift either way
  // (e.g. dropping the lower clamp and accidentally breaking the upper one)
  // is caught.
  assert.equal(humanFileSize(5e18), '4440.89 PB');

  // Sweep across many magnitudes, including the (0, 1) gap and the clamp
  // edges: no output may ever contain "undefined".
  const sizes = [
    0.1,
    0.5,
    0.99,
    1,
    512,
    1023,
    1024,
    1048575,
    1048576,
    2 ** 30,
    2 ** 40,
    1e15,
    5e18,
    Number.MAX_SAFE_INTEGER
  ];
  for (const size of sizes) {
    const out = humanFileSize(size);
    assert.ok(
      !out.includes('undefined'),
      `humanFileSize(${size}) must never contain "undefined" (got ${JSON.stringify(out)})`
    );
    assert.ok(
      /^\d+(\.\d{2})? (B|KB|MB|GB|TB|PB)$/.test(out),
      `humanFileSize(${size}) must render "N.NN <unit>" for a valid unit (got ${JSON.stringify(out)})`
    );
  }
  console.log('ok - upper-bound clamp preserved; sweep never emits "undefined"');
}

// ---- Test 4: validateFileMetadata rejects fractional peer-controlled sizes ----
{
  const MAX = 1024 * 1024 * 1024; // 1 GiB, typical receive option
  const base = { name: 'x.bin', type: 'application/octet-stream', key: new Uint8Array() };

  // Fractional sizes pass the old `size <= 0 / non-finite` check but can
  // never satisfy the receiver's exact-match completion gate — they must be
  // rejected early with the explicit 'invalid file size' error instead of
  // being accepted and dead-ending the transfer. (Values stay below
  // Number.MAX_SAFE_INTEGER so the fractional part survives float64.)
  const badSizes = [0.5, 0.99, 1.5, 1024.7, 4096.0001, 1e12 + 0.5];
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
  console.log('ok - validateFileMetadata rejects fractional sizes with "invalid file size"');

  // The pre-existing rejections are untouched (no regression).
  for (const size of [0, -1, -4096, NaN, Infinity, -Infinity]) {
    const err = validateFileMetadata({ ...base, size }, MAX);
    assert.ok(
      err instanceof Error && err.message === 'invalid file size',
      `size=${String(size)} must stay rejected`
    );
  }

  // Valid integer sizes still pass, including boundary and large values.
  for (const size of [1, 4096, 1024 * 1024, MAX]) {
    assert.equal(
      validateFileMetadata({ ...base, size }, MAX),
      undefined,
      `validateFileMetadata must accept size=${size}`
    );
  }

  // The maxSize upper-bound check still fires for integer sizes.
  const over = validateFileMetadata({ ...base, size: MAX + 1 }, MAX);
  assert.ok(over instanceof Error, 'size > maxSize must still be rejected');
  assert.ok(
    over.message.includes('exceed max size'),
    'the maxSize error must keep its "exceed max size" text'
  );
  console.log('ok - validateFileMetadata still accepts integer sizes and enforces maxSize');
}

// ---- Test 5: static guard — FileCard renders the clamped helper, not an inline copy ----
{
  const source = await readFile(join(here, '..', 'src', 'components', 'FileCard.svelte'), 'utf8');

  // The render site must delegate to the shared helper for metaData.size and
  // the bitrate lines (the three call sites this task pins). An inline
  // reimplementation here would drift from the clamped unit index.
  assert.ok(
    /humanFileSize\(\s*fileDetail\.metaData\.size\s*\)/.test(source),
    'FileCard must render humanFileSize(fileDetail.metaData.size)'
  );
  assert.ok(
    /humanFileSize\(\s*fileDetail\.bitrate\s*\)/.test(source),
    'FileCard must render humanFileSize(fileDetail.bitrate)'
  );
  assert.ok(
    /import\s*\{\s*humanFileSize\s*\}\s*from\s*['"]\.\.\/utils\/humanFileSize['"]/.test(source),
    'FileCard must import humanFileSize from the shared utils module'
  );
  // The helper itself must carry both clamps (defense in depth: if this file
  // is ever "simplified", the sweep in Test 3 catches the behavior and this
  // assertion names the required shape).
  const helperSource = await readFile(join(here, '..', 'src', 'utils', 'humanFileSize.ts'), 'utf8');
  assert.ok(
    /Math\.max\(\s*0,/.test(helperSource),
    'humanFileSize.ts must clamp the unit index to a lower bound of 0'
  );
  assert.ok(
    /Math\.min\(\s*units\.length\s*-\s*1,/.test(helperSource),
    'humanFileSize.ts must keep clamping the unit index to the upper bound'
  );
  console.log(
    'ok - FileCard delegates to the shared clamped helper; both clamps present in the source'
  );
}

console.log(
  'ok - humanFileSize (0,1) lower-bound clamp: no "undefined" unit; validator rejects fractional peer sizes'
);
