// Regression guard for the P0 "ICE server select never propagates to the
// offer link / RTCPeerConnection" bug: CustomSelect exposed only an
// options/customTextEnabled/value binding and no "value committed" callback,
// and OfferOptions passed no handler to the ICE-server control. The parent's
// local iceServer $state updated via the binding, but onChange() — and with
// it onUpdate() — was never invoked from the ICE control, so
// OfferPage.sendOptions.iceServer stayed pinned to
// DEFAULT_SEND_OPTIONS.iceServer: the `i` link param never carried the user's
// choice and the sender's RTCPeerConnection never used a custom/TURN server.
//
// The fix adds an optional onchange callback to CustomSelect (invoked when
// the committed value changes, in the same $effect that writes the bound
// value so the parent always reads the fresh value) and wires
// onchange={onChange} on the ICE control in OfferOptions.
//
// This test statically verifies:
//   1. CustomSelect declares an optional onchange callback prop.
//   2. CustomSelect invokes it from the $effect that syncs `value`, only
//      when the committed value actually changed (guard against duplicate
//      emissions, e.g. while the custom-text editor is open).
//   3. OfferOptions wires the ICE-server CustomSelect with the same
//      onChange handler as the Encryption/Chunk Size selects, keeping the
//      iceServer binding intact.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const customSelectSource = readFileSync(
  join(here, '..', 'src', 'components', 'CustomSelect.svelte'),
  'utf8'
);
const offerOptionsSource = readFileSync(
  join(here, '..', 'src', 'components', 'OfferOptions.svelte'),
  'utf8'
);

// ---- Test 1: CustomSelect exposes an optional onchange callback prop ----
{
  assert.ok(
    /onchange\?\s*:\s*\(\)\s*=>\s*void/.test(customSelectSource),
    'CustomSelect must declare an optional onchange?: () => void prop'
  );
  assert.ok(
    /let\s*\{[^}]*onchange[^}]*\}\s*:\s*Props\s*=\s*\$props\(\)/.test(customSelectSource),
    'CustomSelect must destructure the onchange prop from $props()'
  );
  console.log('ok - CustomSelect exposes an optional onchange callback prop');
}

// ---- Test 2: the callback fires when the committed value changes ----
{
  // The value syncs to the parent through the existing $effect; the callback
  // must be invoked from that same effect (so the parent's onChange reads the
  // value that was just committed) and only on an actual change.
  const effectRe = /\$effect\(\(\)\s*=>\s*\{([\s\S]*?)\n  \}\);/;
  const effectMatch = effectRe.exec(customSelectSource);
  assert.ok(effectMatch, 'CustomSelect must keep its $effect that writes `value`');
  const effectBody = effectMatch[1];

  assert.ok(
    /value\s*=\s*next/.test(effectBody),
    'the $effect must write the committed value back through the binding'
  );
  assert.ok(
    /if\s*\(\s*next\s*!==\s*lastEmitted\s*&&\s*onchange\s*\)/.test(effectBody),
    'the $effect must guard the callback on a value change and the callback existing'
  );
  assert.ok(
    /onchange\(\)/.test(effectBody),
    'the $effect must invoke onchange() when the committed value changes'
  );
  assert.ok(
    /lastEmitted\s*=\s*next/.test(effectBody),
    'the $effect must track the last emitted value to avoid duplicate emissions'
  );
  // Guarding on the callback existing means callers that don't pass one
  // (the old call shape) keep working unchanged.
  assert.ok(
    /lastEmitted\s*=\s*\$state\(value\)/.test(customSelectSource),
    'lastEmitted must be initialized from the initial value so the mount render emits nothing'
  );
  console.log('ok - CustomSelect invokes onchange() on committed value changes');
}

// ---- Test 3: OfferOptions wires the ICE-server control to onChange ----
{
  // The ICE control is the CustomSelect fed by STUN_SERVERS.
  const iceControlRe = /<CustomSelect\s+([\s\S]*?)\/>/;
  const controlMatch = iceControlRe.exec(offerOptionsSource);
  assert.ok(controlMatch, 'OfferOptions must render a CustomSelect for the ICE server');
  const control = controlMatch[1];

  assert.ok(
    /options=\{STUN_SERVERS\}/.test(control),
    'the ICE control must keep using the STUN_SERVERS options'
  );
  assert.ok(
    /bind:value=\{iceServer\}/.test(control),
    'the ICE control must keep binding the local iceServer state'
  );
  assert.ok(
    /onchange=\{onChange\}/.test(control),
    'the ICE control must pass onChange as the onchange callback (the bug: no handler was wired, so sendOptions.iceServer never left the default)'
  );

  // And onChange must keep emitting the current iceServer to the parent.
  const onChangeBlock = /function\s+onChange\s*\(\)\s*\{([\s\S]*?)\n  \}/.exec(offerOptionsSource);
  assert.ok(onChangeBlock, 'OfferOptions must keep its onChange() handler');
  assert.ok(
    /\biceServer\b/.test(onChangeBlock[1]),
    'onChange() must emit the current iceServer to onUpdate'
  );
  console.log('ok - OfferOptions propagates the ICE server choice through onChange');
}

console.log('ok - ICE server selection propagates from the options panel to sendOptions');
