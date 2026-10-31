// Regression guard: bitrate division by zero when accept and the first
// progress update land in the same millisecond.
//
// Both sides of the progress-update path compute the per-file transfer
// bitrate as bytes / elapsed-time, where the elapsed time is
// Date.now() minus the attempt's clock (sender: fileStats.startTime,
// reset in the EVENT_RECEIVER_ACCEPT handler; receiver:
// receivingFiles[id].startTime, set in onAccept()). For a small file
// whose slice.arrayBuffer()/decrypt + first chunk settle within the same
// millisecond, the raw elapsed time is 0, so the division is
// offset / 0 -> Infinity (or NaN): a non-finite value stored in $state
// and rendered through FileCard as a misleading "Sending/Receiving:
// 0 B/sec" (humanFileSize guards non-finite input by returning '0 B')
// until the next 3%-step progress update re-computes with a non-zero
// elapsed time. Verified: Math.round(32768 / (0 / 1000)) === Infinity.
//
// The fix floors the elapsed-time denominator to a 1 ms minimum at both
// call sites:
//   - src/components/sender/Sender.svelte (sendNextChunk progress update)
//     const elapsedMs = Math.max(1, Date.now() - fileStats.startTime);
//     sendingFile.bitrate = Math.round(offset / (elapsedMs / 1000));
//   - src/components/receiver/Receiver.svelte (processChunk progress
//     update)
//     const elapsedMs = Math.max(1, Date.now() - receivingFiles[id].startTime);
//     receivingFiles[id].bitrate =
//       Math.round(receivingFileStatsMap[id].receivedSize / (elapsedMs / 1000));
//
// This keeps the accept-time clock semantics pinned by
// tests/sender-bitrate-clock.test.mjs intact (no clock reset, no
// restructuring of the numerator) and removes only the division-by-zero.
//
// This test is a static source guard over the real components (the
// established style of tests/sender-bitrate-clock.test.mjs /
// tests/receiver-generation-cleanup.test.mjs): Node cannot mount Svelte
// DOM components, so the guard shape is asserted via regex, plus a
// runtime probe that the guarded expression is finite at 0 elapsed ms.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const senderSource = readFileSync(
  join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
  'utf8'
);
const receiverSource = readFileSync(
  join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
  'utf8'
);
const humanFileSizeSource = readFileSync(
  join(here, '..', 'src', 'utils', 'humanFileSize.ts'),
  'utf8'
);

// ---- Runtime probe: the unguarded vs guarded expression at 0 elapsed ms ----
// Documents the bug shape and proves the guard removes the non-finite
// result before anything reaches $state / the UI.
{
  const offset = 32768;
  const elapsedMs = 0;
  assert.equal(
    Math.round(offset / (elapsedMs / 1000)),
    Infinity,
    'probe: the unguarded expression is Infinity at 0 elapsed ms (the bug)'
  );
  assert.ok(
    Number.isFinite(Math.round(offset / (Math.max(1, elapsedMs) / 1000))),
    'probe: the floored (Math.max(1, ...)) expression is finite at 0 elapsed ms'
  );
  // A floor of 0 (or no floor) would still divide by zero; only a
  // positive minimum eliminates the non-finite result.
  assert.ok(!Number.isFinite(Math.round(offset / (Math.max(0, elapsedMs) / 1000))));
  console.log('ok - probe: 1 ms floor makes the bitrate finite at 0 elapsed ms');
}

// ---- Sender: the bitrate division uses a 1 ms-floored elapsed time ----
// The fix keeps the guard as a single, local shape: a const whose
// initializer floors the accept-time clock to a 1 ms minimum, and a
// bitrate division by that const. Both halves are pinned.
// The source is prettier-formatted, so the expression may span several
// lines — match with whitespace-tolerant separators (\s* includes \n).
{
  const SENDER_ELAPSED_FLOOR =
    /const\s+elapsedMs\s*=\s*Math\.max\(\s*1\s*,\s*Date\.now\(\)\s*-\s*fileStats\.startTime\s*\)/;
  const SENDER_BITRATE_DIVISION =
    /sendingFile\.bitrate\s*=\s*Math\.round\(\s*offset\s*\/\s*\(\s*elapsedMs\s*\/\s*1000\s*\)/;
  assert.ok(
    SENDER_ELAPSED_FLOOR.test(senderSource),
    'the sender must floor the accept-time clock to a 1 ms minimum (const elapsedMs = Math.max(1, Date.now() - fileStats.startTime))'
  );
  assert.ok(
    SENDER_BITRATE_DIVISION.test(senderSource),
    'the sender bitrate must divide offset by that floored elapsed time (offset / (elapsedMs / 1000))'
  );
  // The floor must sit inside the progress-update block, immediately
  // before the division it protects.
  const floorIdx = senderSource.search(SENDER_ELAPSED_FLOOR);
  const divIdx = senderSource.search(SENDER_BITRATE_DIVISION);
  assert.ok(
    floorIdx !== -1 && divIdx !== -1 && floorIdx < divIdx && divIdx - floorIdx < 400,
    'the sender elapsed-time floor must sit just before the bitrate division'
  );

  // Negative: the unguarded shape — dividing by the raw
  // (Date.now() - fileStats.startTime) / 1000 — must be gone entirely.
  assert.ok(
    !/offset\s*\/\s*\(\s*\(\s*Date\.now\(\)\s*-\s*fileStats\.startTime\s*\)\s*\/\s*1000\s*\)/.test(
      senderSource
    ),
    'the sender must not divide by an unguarded (Date.now() - fileStats.startTime) / 1000'
  );

  // The clock is untouched by the guard: exactly one reset of the
  // closure clock in the whole file (the ACCEPT handler), none added by
  // the fix. A second reset anywhere would restart the clock
  // mid-transfer and re-inflate the denominator.
  assert.equal(
    (senderSource.match(/fileStats\.startTime\s*=\s*Date\.now\(\)/g) || []).length,
    1,
    'the sender must keep exactly one fileStats.startTime reset (the ACCEPT handler); the zero-elapsed guard must not add a clock reset'
  );

  // The numerator and the progress throttle are untouched.
  assert.ok(
    /fileStats\.progress\s*=\s*Math\.round\(\s*\(\s*offset\s*\/\s*sendingFile\.metaData\.size\s*\)\s*\*\s*100\s*\)/.test(
      senderSource
    ),
    'the sender progress ratio must stay an offset/size ratio (unchanged)'
  );

  console.log('ok - sender: bitrate division is 1 ms-floored, clock and progress untouched');
}

// ---- Receiver: the bitrate division uses a 1 ms-floored elapsed time ----
// Same single local shape: const floor + division by that const.
{
  const RECEIVER_ELAPSED_FLOOR =
    /const\s+elapsedMs\s*=\s*Math\.max\(\s*1\s*,\s*Date\.now\(\)\s*-\s*receivingFiles\[id\]\.startTime\s*\)/;
  const RECEIVER_BITRATE_DIVISION =
    /receivingFiles\[id\]\.bitrate\s*=\s*Math\.round\(\s*receivingFileStatsMap\[id\]\.receivedSize\s*\/\s*\(\s*elapsedMs\s*\/\s*1000\s*\)/;
  assert.ok(
    RECEIVER_ELAPSED_FLOOR.test(receiverSource),
    'the receiver must floor the onAccept-time clock to a 1 ms minimum (const elapsedMs = Math.max(1, Date.now() - receivingFiles[id].startTime))'
  );
  assert.ok(
    RECEIVER_BITRATE_DIVISION.test(receiverSource),
    'the receiver bitrate must divide receivedSize by that floored elapsed time (receivedSize / (elapsedMs / 1000))'
  );
  // The floor must sit inside the progress-update block, immediately
  // before the division it protects.
  const floorIdx = receiverSource.search(RECEIVER_ELAPSED_FLOOR);
  const divIdx = receiverSource.search(RECEIVER_BITRATE_DIVISION);
  assert.ok(
    floorIdx !== -1 && divIdx !== -1 && floorIdx < divIdx && divIdx - floorIdx < 400,
    'the receiver elapsed-time floor must sit just before the bitrate division'
  );

  // Negative: the unguarded shape — dividing by the raw
  // (Date.now() - receivingFiles[id].startTime) / 1000 (in any line
  // layout) — must be gone entirely.
  assert.ok(
    !/receivedSize\s*\/\s*\(\s*\(\s*Date\.now\(\)\s*-\s*receivingFiles\[id\]\.startTime\s*\)\s*\/\s*1000\s*\)/.test(
      receiverSource
    ),
    'the receiver must not divide by an unguarded (Date.now() - receivingFiles[id].startTime) / 1000'
  );

  // The clock is untouched by the guard: the entry clock still starts
  // at ACCEPT time, and exactly once — the fix must not reset or
  // duplicate it.
  assert.equal(
    (receiverSource.match(/receivingFile\.startTime\s*=\s*Date\.now\(\)/g) || []).length,
    1,
    'the receiver must keep exactly one receivingFile.startTime reset (onAccept); the zero-elapsed guard must not add a clock reset'
  );

  // The progress clamp in the same block stays in place: bitrate was the
  // only remaining unbounded derived value there.
  assert.ok(
    /receivingFileStatsMap\[id\]\.progress\s*=\s*Math\.min\(\s*100\s*,\s*Math\.max\(\s*0\s*,\s*Number\.isNaN\(rawProgress\)\s*\?\s*0\s*:\s*rawProgress\s*\)\s*\)/.test(
      receiverSource
    ),
    'the receiver progress clamp must stay in the same progress-update block'
  );

  console.log(
    'ok - receiver: bitrate division is 1 ms-floored, clock and progress clamp untouched'
  );
}

// ---- Render side: humanFileSize still guards non-finite input ----
// The two layers must stay consistent: the guard above keeps the stored
// bitrate finite, and humanFileSize remains the last-line defense for
// any other non-finite value reaching the card.
{
  assert.ok(
    /if\s*\(\s*!Number\.isFinite\(size\)\s*\|\|\s*size\s*<=\s*0\s*\)\s*return\s*'0 B';/.test(
      humanFileSizeSource
    ),
    "humanFileSize must keep guarding non-finite (and <= 0) input with '0 B'"
  );
  console.log('ok - humanFileSize: non-finite render guard intact');
}

console.log(
  'ok - bitrate zero-elapsed guard: same-millisecond progress updates can no longer store Infinity/NaN into bitrate'
);
