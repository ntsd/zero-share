// Regression guard for P0 "peer-controlled unbounded incoming files":
//
// The receiver registered every peer-driven metadata frame unconditionally,
// and with DEFAULT_RECEIVE_OPTIONS.autoAccept = true every one of them was
// auto-accepted without any user action. A malicious/misbehaving peer holding
// a live data channel could therefore stream an unbounded sequence of valid
// metaData frames (each size >= 1 and within the per-file maxSize, up to 2 GB)
// and the receiver processed ALL of them, amplifying into:
//   - a receivingFiles entry + chunk map + stats entry per file (each a
//     rendered FileCard DOM node), never cleaned up until manual Remove;
//   - on completion, a `new Blob` of the whole file held forever;
//   - one success toast per completion, and the toast store kept every toast
//     alive for its full duration (thousands of toasts -> O(n^2) filter + DOM);
//   - unbounded total received bytes (each file individually bounded by
//     maxSize, but no aggregate bound -> gigabytes of resident blobs).
//
// The fix adds two admission caps enforced in onMetaData BEFORE a new entry is
// registered (MAX_INCOMING_FILES active files, MAX_TOTAL_RECEIVED_BYTES
// aggregate bytes); an overflow frame is NOT registered, is bounced back to
// the sender with EVENT_RECEIVER_REJECT via the guarded send(), and produces
// ONE error toast (a per-rejected-file toast would itself be the fan-out the
// cap exists to stop). The toast DOM is additionally bounded to the most
// recent MAX_VISIBLE_TOASTS entries.
//
// Receiver.svelte is a Svelte component (browser-only WebRTC + WebCrypto), so
// this test follows the established source-wiring style (see
// tests/receiver-options-size.test.mjs / offer-processing-failure.test.mjs):
// static verification of the cap wiring plus a dynamic import of the plain-TS
// cap constants to prove their values.
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
const toastSource = readFileSync(join(here, '..', 'src', 'components', 'Toast.svelte'), 'utf8');

// ---- Import the plain-TS cap constants (Node strips the type annotations) ----
const { MAX_INCOMING_FILES, MAX_TOTAL_RECEIVED_BYTES, MAX_VISIBLE_TOASTS } = await import(
  join(here, '..', 'src', 'configs.ts')
);

// ---- Test 1: the cap constants exist, are finite positive integers ----
{
  for (const [name, value] of [
    ['MAX_INCOMING_FILES', MAX_INCOMING_FILES],
    ['MAX_TOTAL_RECEIVED_BYTES', MAX_TOTAL_RECEIVED_BYTES],
    ['MAX_VISIBLE_TOASTS', MAX_VISIBLE_TOASTS]
  ]) {
    assert.ok(
      Number.isInteger(value) && value > 0,
      `${name} must be a positive integer, got ${value}`
    );
  }
  // The active-file cap is a concurrency bound (a small handful), not a byte
  // cap — sanity-check it is a sensible count and that the aggregate byte cap
  // is a real, large bound.
  assert.ok(MAX_INCOMING_FILES <= 64, `MAX_INCOMING_FILES (${MAX_INCOMING_FILES}) should be small`);
  assert.ok(
    MAX_TOTAL_RECEIVED_BYTES >= 1024 * 1024 * 1024,
    `MAX_TOTAL_RECEIVED_BYTES (${MAX_TOTAL_RECEIVED_BYTES}) should be >= 1 GiB`
  );
  // The aggregate byte cap must bound more than a single default-maxSize file
  // so a legitimate multi-file session is possible, but stay far below "no
  // bound" (it is a real guard, not a rubber stamp).
  assert.ok(MAX_TOTAL_RECEIVED_BYTES < Number.MAX_SAFE_INTEGER);
  console.log(
    'ok - MAX_INCOMING_FILES / MAX_TOTAL_RECEIVED_BYTES / MAX_VISIBLE_TOASTS exist and are sane'
  );
}

// ---- Test 2: onMetaData enforces the active-file cap before registration ----
// The guard must count ACTIVE (non-Success) entries and reject the frame when
// adding this one would reach the cap. The reject must (a) NOT register the
// entry, (b) bounce EVENT_RECEIVER_REJECT back to the sender, and (c) emit ONE
// error toast.
{
  const body = extractFunction(receiverSource, 'onMetaData');

  // The file-count admission guard: counts entries whose status is NOT
  // Success and rejects at the cap.
  assert.ok(
    /filter\(\s*\(\s*f\s*\)\s*=>\s*f\.status\s*!==\s*FileStatus\.Success\s*\)/.test(body) ||
      /otherEntries\.filter\(\s*\(\s*f\s*\)\s*=>\s*f\.status\s*!==\s*FileStatus\.Success\s*\)\.length\s*>=\s*MAX_INCOMING_FILES/.test(
        body
      ),
    'onMetaData must count active (non-Success) entries against MAX_INCOMING_FILES'
  );
  assert.ok(
    /MAX_INCOMING_FILES/.test(body),
    'onMetaData must reference the MAX_INCOMING_FILES cap'
  );
  // The active-file cap is an admission gate: reaching it rejects the frame.
  assert.ok(
    /\.length\s*>=\s*MAX_INCOMING_FILES/.test(body),
    'onMetaData must reject when the active-file count reaches MAX_INCOMING_FILES'
  );

  // Registration must happen AFTER the cap check, so an overflow frame is
  // never registered.
  const capCheckIdx = body.search(/\.length\s*>=\s*MAX_INCOMING_FILES/);
  const byteCapCheckIdx = body.search(/MAX_TOTAL_RECEIVED_BYTES/);
  const registerIdx = body.search(/receivingFiles\[id\]\s*=\s*\{/);
  assert.ok(capCheckIdx !== -1, 'active-file cap check must be present');
  assert.ok(registerIdx !== -1, 'onMetaData must still register the entry on the happy path');
  assert.ok(
    capCheckIdx < registerIdx,
    'the active-file cap check must run BEFORE the entry is registered'
  );
  assert.ok(
    byteCapCheckIdx !== -1 && byteCapCheckIdx < registerIdx,
    'the aggregate-bytes cap check must run BEFORE the entry is registered'
  );
  console.log('ok - onMetaData enforces the active-file cap before registration');
}

// ---- Test 3: onMetaData enforces the aggregate-bytes cap before registration ----
{
  const body = extractFunction(receiverSource, 'onMetaData');
  assert.ok(
    /MAX_TOTAL_RECEIVED_BYTES/.test(body),
    'onMetaData must reference the MAX_TOTAL_RECEIVED_BYTES cap'
  );
  // The guard must sum the declared size of the (other) held entries and add
  // this frame's size, rejecting when the total exceeds the cap.
  assert.ok(
    /reduce\(\s*\(\s*sum\s*,\s*f\s*\)\s*=>\s*sum\s*\+\s*f\.metaData\.size\s*,\s*0\s*\)/.test(body),
    'onMetaData must sum the declared size of held entries (f.metaData.size)'
  );
  assert.ok(
    /totalReceivedBytes\s*\+\s*metaData\.size\s*>\s*MAX_TOTAL_RECEIVED_BYTES/.test(body) ||
      /\+\s*metaData\.size\s*>\s*MAX_TOTAL_RECEIVED_BYTES/.test(body),
    'onMetaData must reject when total held + this frame exceeds MAX_TOTAL_RECEIVED_BYTES'
  );
  console.log('ok - onMetaData enforces the aggregate-bytes cap before registration');
}

// ---- Test 4: overflow rejects back to the sender AND emits a single toast ----
// An overflow frame must NOT be registered: it sends EVENT_RECEIVER_REJECT via
// the guarded send() and surfaces exactly ONE error toast (not one per file,
// which would itself be the unbounded fan-out this cap stops).
{
  const body = extractFunction(receiverSource, 'onMetaData');

  // Both cap-overflow branches bounce the reject event back to the sender.
  const rejectSends = body.match(/ReceiveEvent\.EVENT_RECEIVER_REJECT/g) || [];
  assert.ok(
    rejectSends.length >= 2,
    `onMetaData must send EVENT_RECEIVER_REJECT on cap overflow (found ${rejectSends.length} references)`
  );

  // The overflow path emits an error toast naming the rejected file.
  assert.ok(
    /addToastMessage\(\s*[^;]*was rejected[^;]*,\s*['"]error['"]/.test(body),
    'onMetaData must emit an error toast naming the rejected file on cap overflow'
  );

  // The frame's own id is excluded from the counts so a re-offer of a file we
  // already hold cannot reject itself against its own entry.
  assert.ok(
    /filter\(\s*\(\s*key\s*\)\s*=>\s*key\s*!==\s*id\s*\)/.test(body) ||
      /\.filter\(\s*\(\s*key\s*\)\s*=>\s*key\s*!==\s*id\s*\)/.test(body),
    "onMetaData must exclude the frame's own id from the cap counts (re-offer self-count)"
  );

  // The terminal Success short-circuit must run BEFORE the caps so a
  // completed id is neither rejected by nor counted toward them.
  const successReturnIdx = body.search(
    /if\s*\(\s*existing\s*&&\s*existing\.status\s*===\s*FileStatus\.Success\s*\)\s*\{\s*[\s\S]*?\breturn\b/
  );
  const capCheckIdx = body.search(/\.length\s*>=\s*MAX_INCOMING_FILES/);
  assert.ok(successReturnIdx !== -1, 'onMetaData must short-circuit terminal Success entries');
  assert.ok(
    successReturnIdx < capCheckIdx,
    'the terminal-Success short-circuit must run before the admission caps'
  );
  console.log('ok - cap overflow rejects back to the sender and emits a single error toast');
}

// ---- Test 5: the toast DOM is bounded to the most recent MAX_VISIBLE_TOASTS ----
{
  assert.ok(
    /MAX_VISIBLE_TOASTS/.test(toastSource),
    'Toast.svelte must reference the MAX_VISIBLE_TOASTS cap'
  );
  assert.ok(
    /\.slice\(\s*0\s*,\s*MAX_VISIBLE_TOASTS\s*\)/.test(toastSource),
    'Toast.svelte must keep only the most recent MAX_VISIBLE_TOASTS toasts'
  );
  // The slice must bound the list built around the new toast.
  assert.ok(
    /toasts\s*=\s*\[\s*toast\s*,\s*\.+\.toasts\s*\]\s*\.slice\(\s*0\s*,\s*MAX_VISIBLE_TOASTS\s*\)/.test(
      toastSource
    ),
    'Toast.svelte must slice the [new, ...existing] list to the cap'
  );
  console.log('ok - Toast.svelte bounds the rendered toast list to MAX_VISIBLE_TOASTS');
}

console.log(
  'ok - receiver incoming caps: active-file + aggregate-byte admission gates, reject-back + single toast, bounded toast DOM'
);
