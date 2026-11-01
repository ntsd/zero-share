// Regression guard: receivingFileGeneration per-file map cleanup
//
// The receiver tracks a per-file attempt generation
// (`receivingFileGeneration`) that fences in-flight serializeTask
// continuations across a re-offer (a stale attempt's chunk is dropped instead
// of landing on the new attempt's chunk map). Every sibling per-file map
// (receivingFileChunkMap, receivingFileStatsMap, chunkQueue) is deleted on
// each of the five disposal paths, but receivingFileGeneration was ONLY
// bumped and read — never deleted. Since every file id is a fresh
// crypto.randomUUID() (Sender.svelte onFilesPick), an id is never reused, so
// one entry (a number keyed by a file id) persisted for the entire component
// lifetime for every distinct file id ever received: an unbounded,
// never-released per-file structure.
//
// The fix releases the entry on every terminal/disposal path:
//   1. onRemove(key)        — user removes the file
//   2. onDeny(key)          — user denies the file
//   3. onChannelClose()     — the channel died; no transfer can complete
//   4. rejectFile()         — corrupt chunk / oversized stream reject
//   5. processChunk success — terminal Success (a Success re-offer is
//                             ignored by onMetaData, so the generation can
//                             never matter again)
//
// It must NOT be released on the onMetaData re-offer teardown, where the
// same entry is intentionally bumped and retained for the new attempt.
//
// File ids are unique per pick, so a released id is never re-offered or
// re-encountered — the deletes cannot fence a still-live attempt. This
// test is a static source guard over the real component (the established
// style of tests/receiver-incoming-caps.test.mjs /
// tests/resend-after-chunk-failure.test.mjs): the runtime fence semantics
// themselves are covered by tests/resend-after-chunk-failure.test.mjs, which
// must keep passing unchanged.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ---- Helper: find the body of a named (async) function in Svelte source ----
function extractFunction(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.ok(start !== -1, `${name}() must exist`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new assert.AssertionError({ message: `${name}(): unbalanced braces` });
}

const receiverSource = readFileSync(
  join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
  'utf8'
);

const DELETE_GEN = /delete\s+receivingFileGeneration\s*\[[^\]]+\]\s*;/g;
const DELETE_CHUNK_MAP = /delete\s+receivingFileChunkMap\s*\[[^\]]+\]\s*;/;
const DELETE_STATS_MAP = /delete\s+receivingFileStatsMap\s*\[[^\]]+\]\s*;/;
const DELETE_QUEUE = /delete\s+chunkQueue\s*\[[^\]]+\]\s*;/;

// ---- Invariant: the five disposal paths each release the generation entry
// alongside the sibling per-file maps they already delete ----
for (const fnName of ['onRemove', 'onDeny', 'onChannelClose', 'rejectFile', 'processChunk']) {
  const body = extractFunction(receiverSource, fnName);
  assert.ok(
    DELETE_CHUNK_MAP.test(body) && DELETE_STATS_MAP.test(body) && DELETE_QUEUE.test(body),
    `${fnName}() must delete the per-file chunk map, stats map, and chunk queue (pre-existing invariant)`
  );
  const genDeletes = [...body.matchAll(DELETE_GEN)];
  assert.equal(
    genDeletes.length,
    1,
    `${fnName}() must delete receivingFileGeneration exactly once alongside its sibling per-file map deletes`
  );
  // The generation delete must come AFTER the sibling deletes (it is the
  // last thing released on that path) — releasing it first would leave a
  // stale-generation window for the very teardown it belongs to.
  const lastSiblingIdx = Math.max(
    body.search(DELETE_CHUNK_MAP),
    body.search(DELETE_STATS_MAP),
    body.search(DELETE_QUEUE)
  );
  assert.ok(
    genDeletes[0].index > lastSiblingIdx,
    `${fnName}() must delete receivingFileGeneration after its sibling per-file maps`
  );
  console.log(`ok - ${fnName} releases receivingFileGeneration with its sibling per-file maps`);
}

// ---- processChunk: the delete sits in the SUCCESS branch only ----
// It must land in the `receivedSize === metaData.size` branch (terminal
// Success) and NOT in the overshoot branch — the overshoot branch rejects
// via rejectFile(), which owns its own (fence-safe) generation release.
{
  const body = extractFunction(receiverSource, 'processChunk');
  const successIdx = body.search(/receivingFiles\[id\]\.status\s*=\s*FileStatus\.Success/);
  const elseIdx = body.search(/\} else if/);
  const genIdx = body.search(DELETE_GEN);
  assert.ok(
    successIdx !== -1 && elseIdx !== -1 && genIdx !== -1,
    'processChunk: Success branch, overshoot branch, and generation delete must all be locatable'
  );
  assert.ok(
    genIdx > successIdx && genIdx < elseIdx,
    'processChunk must delete receivingFileGeneration inside the terminal-Success branch, not the overshoot branch'
  );
  console.log('ok - processChunk releases the generation only on the terminal-Success path');
}

// ---- onChannelClose: the delete is inside the chunk-map teardown loop ----
// Every active in-flight file is torn down there; a generation entry left
// behind for a just-dead channel would be exactly the leak (no re-offer can
// ever come for it — the channel is gone).
{
  const body = extractFunction(receiverSource, 'onChannelClose');
  const loopIdx = body.search(/for\s*\(const\s+id\s+of\s+Object\.keys\(receivingFileChunkMap\)\)/);
  const genIdx = body.search(DELETE_GEN);
  assert.ok(loopIdx !== -1, 'onChannelClose must iterate the per-file chunk map for teardown');
  assert.ok(
    genIdx !== -1 && genIdx > loopIdx,
    'onChannelClose must delete receivingFileGeneration inside its teardown loop'
  );
  console.log('ok - onChannelClose releases every in-flight file generation in its teardown loop');
}

// ---- rejectFile: the delete is AFTER the live-attempt guard ----
// rejectFile no-ops when the per-file chunk map is already gone (the file is
// no longer actively receiving), so the generation release must sit after
// that guard — otherwise a no-op reject would still burn the entry.
{
  const body = extractFunction(receiverSource, 'rejectFile');
  const guardIdx = body.search(/if\s*\(\s*!receivingFileChunkMap\[id\]\s*\)\s*\{\s*\n\s*return;/);
  const genIdx = body.search(DELETE_GEN);
  assert.ok(guardIdx !== -1, 'rejectFile must keep its no-op guard on a missing chunk map');
  assert.ok(
    genIdx !== -1 && genIdx > guardIdx,
    'rejectFile must delete receivingFileGeneration after its guard, with its other teardown deletes'
  );
  console.log('ok - rejectFile releases the generation with its reject teardown');
}

// ---- The ONLY exception: the onMetaData re-offer teardown bumps and keeps ----
// A re-offer of a still-active file intentionally reuses the same entry: it
// is bumped so stale-attempt continuations are fenced against the NEW
// attempt. Deleting it there would reset the fence to 0 and let the old
// attempt's in-flight chunks (captured generation >= 1, or the freshly
// re-enqueued ones) land on the new chunk map — the double-count regression
// the generation exists to prevent.
{
  const body = extractFunction(receiverSource, 'onMetaData');
  assert.ok(
    /receivingFileGeneration\[id\]\s*=\s*\(receivingFileGeneration\[id\]\s*\?\?\s*0\)\s*\+\s*1/.test(
      body
    ),
    'onMetaData must still bump the generation on a re-offer'
  );
  assert.equal(
    (body.match(DELETE_GEN) || []).length,
    0,
    'onMetaData re-offer teardown must NOT delete receivingFileGeneration (the entry is re-bumped and retained for the new attempt)'
  );
  console.log('ok - onMetaData re-offer bumps and retains the generation (no delete)');
}

// ---- Whole-file invariant: exactly the five disposal deletes, no others ----
{
  const allDeletes = receiverSource.match(DELETE_GEN) || [];
  assert.equal(
    allDeletes.length,
    5,
    `receivingFileGeneration must have exactly five delete sites (onRemove, onDeny, onChannelClose, rejectFile, processChunk success) — found ${allDeletes.length}`
  );
  const bumps = (receiverSource.match(/receivingFileGeneration\[id\]\s*=\s*\(/g) || []).length;
  assert.equal(bumps, 1, 'exactly one write-bump site (the onMetaData re-offer) may exist');
  console.log('ok - exactly five generation delete sites and one bump site in Receiver.svelte');
}

console.log(
  'ok - receiver generation cleanup: every disposal path releases receivingFileGeneration; the re-offer path retains it'
);
