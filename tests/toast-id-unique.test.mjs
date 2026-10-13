// Regression guard for P1 "toast id collision via Date.now() — two toasts in
// the same millisecond share one id and the first dismissal timer cancels
// both early".
//
// addToastMessage() used to key every toast by `Date.now().toString()`.
// Toast.svelte removes a toast by filtering the shared list on that exact
// id, so two toasts added in the SAME millisecond (e.g. a burst of
// "Received <file>" successes, or "Connected" + "ICE Candidate error")
// shared one id: the first dismissal timer removed BOTH toasts at once and
// the second never got its full duration.
//
// The fix: id the toast with `crypto.randomUUID()` — the established
// unique-id pattern in this codebase (Sender.svelte onFilesPick).
//
// The store is plain TS, so this test both statically checks the source
// (mirroring the other static regression guards) and dynamically imports it
// (Node strips the type annotations natively; nanostores is a dev dep) to
// prove two same-millisecond calls yield distinct ids.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'stores', 'toastStore.ts'), 'utf8');

// ---- Helper: find the body of a named function in the store source ----
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

// ---- Test 1: id comes from crypto.randomUUID(), not Date.now() ----
{
  const body = extractFunction(source, 'addToastMessage');
  assert.ok(
    body.includes('crypto.randomUUID()'),
    'addToastMessage must id toasts with crypto.randomUUID()'
  );
  assert.ok(
    !body.includes('Date.now()'),
    'addToastMessage must not derive the id from Date.now() (same-millisecond collision)'
  );
  console.log('ok - addToastMessage ids toasts via crypto.randomUUID()');
}

// ---- Test 2: two same-millisecond calls produce distinct, valid ids ----
{
  const { toastAtom, addToastMessage } = await import(
    join(here, '..', 'src', 'stores', 'toastStore.ts')
  );

  // Freeze the clock so both calls land in the same millisecond — exactly
  // the scenario that produced the collision.
  const realNow = Date.now;
  const frozen = realNow.call();
  Date.now = () => frozen;
  try {
    addToastMessage('first');
    const first = toastAtom.get();
    addToastMessage('second');
    const second = toastAtom.get();

    assert.notEqual(
      first.id,
      second.id,
      'two toasts added in the same millisecond must have distinct ids'
    );
    assert.match(
      second.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'toast id must be a valid UUID'
    );
    // The message/status/duration fields must still flow through.
    assert.equal(second.message, 'second');
    assert.equal(second.status, 'info');
    assert.equal(second.duration, 5000);
  } finally {
    Date.now = realNow;
  }
  console.log('ok - same-millisecond addToastMessage calls yield distinct ids');
}
