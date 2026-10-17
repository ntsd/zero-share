// Regression guard for P0 "Resend button is a guaranteed silent no-op after a
// connection loss": when the peer's data channel dies, onChannelClose() marks
// every in-flight/failed file with error='Connection lost — transfer aborted'
// + status=Pending, and Sender.svelte's onSend() on the dead channel is a
// state-preserving no-op (send() returns false on connectionLost) that only
// re-stamps the same error. But SendingFileList.svelte rendered a Resend
// button for ANY entry whose error is truthy — so after every connection loss
// the user saw a dead "Resend" that can never succeed (this app has no
// reconnection path), with zero feedback on click: click it forever, nothing
// ever happens.
//
// The fix (UI affordance only — the send logic is unchanged): Sender.svelte
// threads its `connectionLost` flag into SendingFileList, and the list gates
// the Resend button on the channel NOT being lost. After onChannelClose()
// every entry on this peer is connection-lost, so hiding Resend for ALL
// entries is correct and avoids matching on an error-message string that
// could drift. Remove (and the error banner via FileCard) stay, which is the
// only meaningful action. On a live channel, transiently failed entries
// (chunk failure / receiver reject) keep their working Resend.
//
// This test is static: Node cannot mount Svelte DOM components, so it reads
// both .svelte sources and asserts the wiring + guard exist, mirroring
// tests/drag-drop-paste.test.mjs and tests/receiver-remove-download-null-guard.test.mjs.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const senderSource = readFileSync(
  join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
  'utf8'
);
const listSource = readFileSync(
  join(here, '..', 'src', 'components', 'sender', 'SendingFileList.svelte'),
  'utf8'
);

// ---- Helper: extract the {#if ...} condition that guards the Resend button ----
function extractResendCondition(source) {
  // The Resend button is the only button whose onclick is onSend(key) and whose
  // visible label is " Resend " (the plain Send button's label is " Send ").
  const buttonIndex = source.search(
    /<button[^>]*onclick=\{\(\)\s*=>\s*onSend\(key\)[^>]*>\s*Resend\s*</
  );
  assert.ok(buttonIndex !== -1, 'SendingFileList.svelte must render the Resend button');
  // Walk back to the {#if that opens this branch: the nearest '{#if' before the
  // button, with no intervening '{/if}' (a nested close would end its branch).
  const before = source.slice(0, buttonIndex);
  const ifIndex = before.lastIndexOf('{#if');
  assert.ok(ifIndex !== -1, 'the Resend button must sit inside a {#if} branch');
  const between = before.slice(ifIndex);
  assert.ok(
    !/^\{\/if\}/.test(between),
    'no {/if} may appear between the {#if and the Resend button (wrong branch)'
  );
  const condStart = ifIndex + 4;
  const condEnd = source.indexOf('}', condStart);
  assert.ok(condEnd !== -1, 'the Resend {#if} condition must be closed');
  return source.slice(condStart, condEnd).trim();
}

// ---- Test 1: the Resend button is gated on the channel not being lost ----
{
  const condition = extractResendCondition(listSource);
  // Both halves of the guard must be present: the original error check is
  // preserved (live-channel transient failures still get Resend) AND the new
  // dead-channel suppression is ANDed in.
  assert.ok(
    /sendingFile\.error/.test(condition),
    `Resend gate must still check sendingFile.error (got: ${condition})`
  );
  assert.ok(
    /!connectionLost/.test(condition),
    `Resend gate must suppress when connectionLost (got: ${condition})`
  );
  assert.ok(/&&/.test(condition), `both guards must be ANDed together (got: ${condition})`);
  console.log('ok - Resend button is gated on sendingFile.error && !connectionLost');
}

// ---- Test 2: the list declares and receives the connectionLost prop ----
{
  assert.ok(
    /connectionLost:\s*boolean/.test(listSource),
    'SendingFileList Props must declare connectionLost: boolean'
  );
  assert.ok(
    /\$\s*props\s*\(\s*\)/.test(listSource) && /connectionLost/.test(listSource),
    'connectionLost must be destructured from $props()'
  );
  // The flag must actually reach the list: the element invocation in
  // Sender.svelte must forward it, and the destructuring must include it.
  assert.ok(
    /<SendingFileList[^\n]*\{connectionLost\}/.test(senderSource),
    'Sender.svelte must pass {connectionLost} into <SendingFileList />'
  );
  const destructure = listSource.search(
    /const\s*\{[^}]*connectionLost[^}]*\}\s*:\s*Props\s*=\s*\$props\(\)/
  );
  assert.ok(
    destructure !== -1,
    'connectionLost must be in the $props() destructure of SendingFileList'
  );
  console.log('ok - Sender threads connectionLost into SendingFileList');
}

// ---- Test 3: the other affordances are untouched ----
{
  // Live-channel behavior preserved: a transiently failed entry (error set,
  // channel still open) STILL gets Resend — the gate is the connectionLost
  // flag only, not a re-statement of the error message. No string-matching
  // on "Connection lost" in the UI (that wording could drift).
  assert.ok(
    !/Connection lost/.test(listSource),
    'SendingFileList must not special-case the connection-lost error string'
  );
  // The other branches keep their original conditions (no drift):
  assert.ok(
    /:\s*else\s+if\s+sendingFile\.stop\b/.test(listSource),
    'the Continue branch must still be keyed on sendingFile.stop'
  );
  assert.ok(
    /:\s*else\s+if\s+sendingFile\.status\s*===\s*FileStatus\.Processing\b/.test(listSource),
    'the Stop branch must still be keyed on status === Processing'
  );
  // Remove stays unconditional: it is the only meaningful action on a dead
  // channel and must remain available for every entry.
  const removeButton = /<button[^>]*onclick=\{\(\)\s*=>\s*onRemove\(key\)[^>]*>\s*Remove\s*</;
  assert.ok(removeButton.test(listSource), 'the Remove button must remain available');
  const removeIndex = listSource.search(removeButton);
  assert.ok(removeIndex !== -1, 'the Remove button must exist');
  // Remove must sit OUTSIDE the {#if button chain (no {#if / {:else} between
  // its opening and the branch's end {/if}) so a dead-channel entry still gets
  // it even though Resend/Stop/Continue are all suppressed.
  const afterResendIf = listSource.slice(listSource.indexOf('{#if sendingFile.error'));
  assert.ok(
    afterResendIf.indexOf('{/if}') < afterResendIf.lastIndexOf('Remove'),
    'Remove must render after the action-button {#if} chain closes (unconditional)'
  );
  console.log('ok - Continue/Stop branches and Remove are unchanged; no error-string matching');
}

// ---- Test 4: the send-side no-op behavior is intentionally untouched ----
{
  // Acceptance criterion 3: onSend on a dead channel must REMAIN a no-op that
  // preserves state — this fix removes only the UI affordance. The dead-channel
  // branch in onSend (re-stamp connection-lost error when the entry has none,
  // bounce to Pending) must still be present.
  assert.ok(
    /if\s*\(\s*!\s*f\.error\s*\)\s*\{[\s\S]*?Connection lost — transfer aborted[\s\S]*?f\.status\s*=\s*FileStatus\.Pending;/.test(
      senderSource
    ),
    'onSend must still surface the connection-lost error on a dead channel'
  );
  // onContinue's dead-channel guard must remain (a resume into a dead channel
  // would leave a cleared stop flag behind a dead connection).
  assert.ok(
    /function\s+onContinue[\s\S]*?if\s*\(\s*connectionLost\s*\)\s*return;/.test(senderSource),
    'onContinue must still no-op when connectionLost'
  );
  console.log('ok - onSend/onContinue dead-channel behavior preserved (UI-only fix)');
}

console.log('ok - sender Resend after connection loss: dead Resend affordance suppressed');
