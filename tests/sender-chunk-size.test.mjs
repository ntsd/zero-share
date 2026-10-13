// Regression guard for the P0 "sender Chunk Size dropdown emits a STRING
// chunkSize" bug: Svelte 5 <select bind:value> assigns the DOM option value
// back as a STRING — the same mechanism the repo already fixed on the
// receiver side for maxSize (PR #44, tests/receiver-options-size.test.mjs).
//
// The sender path never applied that fix:
//   - OfferOptions.svelte:47 bound `chunkSize` (a number) to a <select>, and
//     onChange() emitted it un-coerced, so OfferPage.sendOptions.chunkSize
//     became a string after any user interaction.
//   - Sender.svelte sendNextChunk() then did `offset + chunkSize` — string
//     concatenation: 32768 + "32768" -> "3276832768" (3.2 GB), so every
//     slice after the first was clamped to the entire remaining file and the
//     whole remainder shipped as one giant over-sized "chunk", with progress
//     and bitrate computed off the corrupted offset progression.
//
// This test verifies:
//   1. OfferOptions.svelte onChange() coerces chunkSize to a number and
//      whitelists it against CHUNK_SIZE_OPTIONS (the same single source of
//      truth ReceivePage uses for the `c` param) before calling onUpdate —
//      static source guards plus the coercion decision driven with the
//      string values a real <select> produces.
//   2. The chunk-slicing math in Sender.svelte is numeric: with a real File,
//      string input chunk sizes slice at the configured boundary (no
//      concatenated offsets) and the pre-fix expression demonstrably
//      produces the over-sized end offset.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Node 22+ strips types natively, so exercise the REAL whitelist and default
// instead of copies that could drift from src/configs.ts.
const { CHUNK_SIZE_OPTIONS, DEFAULT_SEND_OPTIONS } = await import(
  join(here, '..', 'src', 'configs.ts')
);

const offerSource = readFileSync(
  join(here, '..', 'src', 'components', 'OfferOptions.svelte'),
  'utf8'
);
const senderSource = readFileSync(
  join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
  'utf8'
);

// ---- Sanity: the configs single source of truth is sound ----
assert.ok(CHUNK_SIZE_OPTIONS.length > 0, 'CHUNK_SIZE_OPTIONS must not be empty');
for (const size of CHUNK_SIZE_OPTIONS) {
  assert.ok(
    Number.isInteger(size) && size > 0,
    `CHUNK_SIZE_OPTIONS entries must be positive integers, got ${size}`
  );
}
assert.ok(
  Number.isInteger(DEFAULT_SEND_OPTIONS.chunkSize) && DEFAULT_SEND_OPTIONS.chunkSize > 0,
  `DEFAULT_SEND_OPTIONS.chunkSize must be a positive integer, got ${DEFAULT_SEND_OPTIONS.chunkSize}`
);

// ---- Test 1: OfferOptions onChange() coerces chunkSize before emitting ----
{
  const onChangeBlock = /function\s+onChange\s*\(\)\s*\{([\s\S]*?)\n  \}/.exec(offerSource);
  assert.ok(onChangeBlock, 'OfferOptions.onChange() function must exist');
  const body = onChangeBlock[1];

  // The select must still be bound to chunkSize (the bug only happens via
  // user interaction, so removing the binding would void the fix).
  assert.ok(
    /<select\s+bind:value=\{chunkSize\}/.test(offerSource),
    'the Chunk Size <select> must keep bind:value={chunkSize}'
  );

  // Coercion + whitelist before the emit (mirrors ReceiverOptions.maxSize):
  assert.ok(
    /Number\(\s*chunkSize\s*\)/.test(body),
    'onChange() must call Number(chunkSize) to coerce the select binding back to a number'
  );
  assert.ok(
    /CHUNK_SIZE_OPTIONS\.includes\(\s*parsed\s*\)/.test(body),
    'onChange() must whitelist the coerced value against CHUNK_SIZE_OPTIONS'
  );
  assert.ok(
    /DEFAULT_SEND_OPTIONS\.chunkSize/.test(body),
    'onChange() must fall back to DEFAULT_SEND_OPTIONS.chunkSize for non-whitelisted values'
  );
  // The emit must pass the coerced value, never the raw binding:
  // `chunkSize,` as a shorthand or `chunkSize: chunkSize` would re-emit the string.
  assert.ok(
    !/chunkSize:\s*chunkSize\b/.test(body) && !/^\s*chunkSize,\s*$/m.test(body),
    'onChange() must not emit the raw (un-coerced) chunkSize binding'
  );
  console.log('ok - OfferOptions onChange() coerces chunkSize to a number and whitelists it');
}

// ---- Test 2: the coercion decision driven with real <select> string values ----
{
  // This is exactly the expression onChange() now emits: Number() the string
  // DOM option value, keep it only when it is in the whitelist, else default.
  function emittedChunkSize(rawValue) {
    const parsed = Number(rawValue);
    return CHUNK_SIZE_OPTIONS.includes(parsed) ? parsed : DEFAULT_SEND_OPTIONS.chunkSize;
  }

  // What a real <select bind:value={chunkSize}> yields: the option value as
  // a string — e.g. "32768".
  const STRING_DEFAULT = String(DEFAULT_SEND_OPTIONS.chunkSize);
  for (const size of CHUNK_SIZE_OPTIONS) {
    const emitted = emittedChunkSize(String(size));
    assert.equal(
      typeof emitted,
      'number',
      `emitted chunkSize must be a number, got ${typeof emitted}`
    );
    assert.equal(emitted, size, `string "${String(size)}" must map back to ${size}`);
  }
  // The default option value round-trips too (user never touched the select).
  assert.equal(emittedChunkSize(STRING_DEFAULT), DEFAULT_SEND_OPTIONS.chunkSize);
  // Adversarial values a binding could theoretically carry:
  assert.equal(emittedChunkSize('32768abc'), DEFAULT_SEND_OPTIONS.chunkSize);
  assert.equal(emittedChunkSize(''), DEFAULT_SEND_OPTIONS.chunkSize);
  assert.equal(
    emittedChunkSize('4096'),
    DEFAULT_SEND_OPTIONS.chunkSize,
    'off-whitelist value must fall back to the default'
  );
  assert.equal(emittedChunkSize(undefined), DEFAULT_SEND_OPTIONS.chunkSize);
  console.log('ok - coercion decision maps every dropdown string back to its number');
}

// ---- Test 3: the slice math in Sender.svelte stays numeric ----
{
  // The pre-fix defect, demonstrated: with a string chunkSize,
  // `offset + chunkSize` concatenates instead of adding, so the slice end
  // clamps to the whole remainder of the file.
  const chunkSizeStr = '32768';
  const offsetAfterFirstChunk = 32768;
  const buggyEnd = offsetAfterFirstChunk + chunkSizeStr; // "3276832768"
  assert.equal(typeof buggyEnd, 'string', 'pre-fix expression concatenated (the bug)');
  assert.equal(
    Number(buggyEnd),
    3276832768,
    'concatenated end offset is ~3.2 GB, far beyond any file'
  );

  // The post-fix math: Sender.svelte must coerce to a number first and slice
  // with the numeric value.
  const parsedChunkSize = Number(chunkSizeStr);
  const chunkBytes =
    Number.isFinite(parsedChunkSize) && parsedChunkSize > 0 ? parsedChunkSize : 32 * 1024;
  assert.equal(typeof chunkBytes, 'number');
  const fixedEnd = offsetAfterFirstChunk + chunkBytes;
  assert.equal(typeof fixedEnd, 'number', 'post-fix slice end must be a number');
  assert.equal(fixedEnd, 65536, 'post-fix slice end is offset + chunk, not offset + "chunk"');

  // Drive the exact slice boundary with a real File: chunking a 100KB file
  // with a STRING 32KB chunk size (as OfferOptions used to emit) must yield
  // 32768-byte chunks, not one 68KB remainder.
  const fileSize = 100 * 1024;
  const file = new File([new Uint8Array(fileSize)], 'test.bin', {
    type: 'application/octet-stream'
  });
  let offset = 0;
  let chunks = 0;
  while (offset < fileSize) {
    const slice = file.slice(offset, offset + chunkBytes);
    const buffer = await slice.arrayBuffer();
    assert.ok(
      buffer.byteLength > 0 && offset < fileSize,
      'no empty chunk may be produced while bytes remain'
    );
    assert.ok(
      buffer.byteLength <= chunkBytes,
      `chunk ${chunks} is ${buffer.byteLength} bytes, exceeds the configured ${chunkBytes} chunk size`
    );
    offset += buffer.byteLength;
    chunks += 1;
  }
  assert.equal(chunks, 4, `100KB / 32KB must be 4 chunks (3 x 32KB + 4KB), got ${chunks}`);
  assert.equal(offset, fileSize, 'offset progression must land exactly on the file size');

  // Source guard: the raw `offset + chunkSize` (un-coerced) must be gone, and
  // the coercion must live in sendNextChunk().
  assert.ok(
    !/file\.slice\(\s*offset\s*,\s*offset\s*\+\s*chunkSize\s*\)/.test(senderSource),
    'Sender.svelte must not slice with the un-coerced chunkSize'
  );
  const sendNextChunkBlock = /function sendNextChunk\s*\(\)\s*\{([\s\S]*?)\n    \}/.exec(
    senderSource
  );
  assert.ok(sendNextChunkBlock, 'Sender.svelte sendNextChunk() must exist');
  const chunkBody = sendNextChunkBlock[1];
  assert.ok(
    /Number\(\s*chunkSize\s*\)/.test(chunkBody),
    'sendNextChunk() must coerce chunkSize with Number()'
  );
  assert.ok(
    /Number\.isFinite/.test(chunkBody),
    'sendNextChunk() must guard the coerced value with Number.isFinite'
  );
  assert.ok(
    /file\.slice\(\s*offset\s*,\s*offset\s*\+\s*chunkBytes\s*\)/.test(chunkBody),
    'sendNextChunk() must slice with the numeric chunkBytes'
  );
  console.log('ok - chunk slicing math stays numeric end-to-end');
}

console.log('ok - sender chunk size: dropdown strings are coerced before send');
