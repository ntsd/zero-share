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
// bytes / 0 -> Infinity (or NaN): a non-finite value stored in $state
// and rendered through FileCard as a misleading "Sending/Receiving:
// 0 B/sec" (humanFileSize guards non-finite input by returning '0 B')
// until the next 3%-step progress update re-computes with a non-zero
// elapsed time. Verified: Math.round(32768 / (0 / 1000)) === Infinity.
//
// The progress + bitrate UI-update block that both call sites shared was
// copy-pasted in lockstep and has now been deduplicated into
// src/utils/transferProgress.ts (updateTransferProgress). The zero-elapsed
// floor — the ONLY fix this guard pins — therefore lives in exactly one
// place: the helper. This test asserts the guarded shape in the helper and
// keeps a thin call-site assertion that BOTH components still route their
// progress update through it (so a future refactor cannot silently drop the
// update from one side, re-introducing a second copy of the floor).
//
// The accept-time clock semantics pinned by
// tests/sender-bitrate-clock.test.mjs stay intact (no clock reset, no
// restructuring of the numerator) and are asserted there, not here.
//
// This test is a static source guard over the real helper + components
// (the established style of tests/sender-bitrate-clock.test.mjs /
// tests/receiver-generation-cleanup.test.mjs): Node cannot mount Svelte
// DOM components, so the guard shape is asserted via regex, plus a runtime
// probe that the guarded expression is finite at 0 elapsed ms.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const helperSource = readFileSync(join(here, '..', 'src', 'utils', 'transferProgress.ts'), 'utf8');
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

// ---- Helper: the bitrate division uses a 1 ms-floored elapsed time ----
// The floor sits in the shared helper as a single local shape: a const whose
// initializer floors the accept-time clock (stats.startTime) to a 1 ms
// minimum, and a bitrate division by that const. Both halves are pinned.
// The source is prettier-formatted, so the expression may span several
// lines — match with whitespace-tolerant separators (\s* includes \n).
{
  const HELPER_ELAPSED_FLOOR =
    /const\s+elapsedMs\s*=\s*Math\.max\(\s*1\s*,\s*Date\.now\(\)\s*-\s*stats\.startTime\s*\)/;
  const HELPER_BITRATE_DIVISION =
    /writeTo\.bitrate\s*=\s*Math\.round\(\s*sentBytes\s*\/\s*\(\s*elapsedMs\s*\/\s*1000\s*\)/;
  assert.ok(
    HELPER_ELAPSED_FLOOR.test(helperSource),
    'the helper must floor the accept-time clock to a 1 ms minimum (const elapsedMs = Math.max(1, Date.now() - stats.startTime))'
  );
  assert.ok(
    HELPER_BITRATE_DIVISION.test(helperSource),
    'the helper bitrate must divide sentBytes by that floored elapsed time (sentBytes / (elapsedMs / 1000))'
  );
  // The floor must sit inside the progress-update block, immediately
  // before the division it protects.
  const floorIdx = helperSource.search(HELPER_ELAPSED_FLOOR);
  const divIdx = helperSource.search(HELPER_BITRATE_DIVISION);
  assert.ok(
    floorIdx !== -1 && divIdx !== -1 && floorIdx < divIdx && divIdx - floorIdx < 400,
    'the helper elapsed-time floor must sit just before the bitrate division'
  );

  // Negative: the unguarded shape — dividing by the raw
  // (Date.now() - stats.startTime) / 1000 — must not exist in the helper.
  assert.ok(
    !/sentBytes\s*\/\s*\(\s*\(\s*Date\.now\(\)\s*-\s*stats\.startTime\s*\)\s*\/\s*1000\s*\)/.test(
      helperSource
    ),
    'the helper must not divide by an unguarded (Date.now() - stats.startTime) / 1000'
  );

  console.log('ok - helper: bitrate division is 1 ms-floored (single source of truth)');
}

// ---- Call sites: both components still route through the helper ----
// The dedup moved the floor out of the two components; a thin assertion that
// each still calls updateTransferProgress (and no longer carries its own
// bitrate floor) keeps the update wired on BOTH sides — a regression that
// dropped the call from one side, or reintroduced a second copy of the
// floor, would fail here.
{
  assert.ok(
    senderSource.includes("import { updateTransferProgress } from '../../utils/transferProgress';"),
    'the sender must import the shared progress helper'
  );
  assert.ok(
    /updateTransferProgress\(\s*fileStats\s*,\s*offset\s*,\s*sendingFile\.metaData\.size\s*,\s*sendingFile\s*\)/.test(
      senderSource
    ),
    'the sender must compute its progress + bitrate through updateTransferProgress'
  );
  assert.ok(
    receiverSource.includes(
      "import { updateTransferProgress } from '../../utils/transferProgress';"
    ),
    'the receiver must import the shared progress helper'
  );
  assert.ok(
    /updateTransferProgress\(\s*receivingFileStatsMap\[id\]\s*,\s*receivingFileStatsMap\[id\]\.receivedSize\s*,\s*receivingFile\.metaData\.size\s*,\s*receivingFiles\[id\]\s*\)/.test(
      receiverSource
    ),
    'the receiver must compute its progress + bitrate through updateTransferProgress'
  );

  // The old per-component floor copies must be gone: the floor now exists
  // only in the helper, so no component may declare its own `elapsedMs`
  // floored to 1, or divide a bitrate by a locally-derived raw elapsed time.
  for (const [name, source] of [
    ['sender', senderSource],
    ['receiver', receiverSource]
  ]) {
    assert.ok(
      !/const\s+elapsedMs\s*=\s*Math\.max\(\s*1\s*,/.test(source),
      `${name} must no longer declare its own 1 ms elapsed-time floor (it lives in the helper)`
    );
    assert.ok(
      !/\.bitrate\s*=\s*Math\.round\(\s*[^)]*\/\s*1000/.test(source),
      `${name} must no longer compute its own bitrate division (it lives in the helper)`
    );
  }

  console.log(
    'ok - call sites: both components route their progress + bitrate through the shared helper'
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
