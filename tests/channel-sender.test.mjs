// Regression guard for the dedup of the guarded data-channel send: the
// identical ~15-line guarded-send implementation (dead-channel flag +
// readyState check + throwing send catch) was copy-pasted into
// Sender.svelte and Receiver.svelte — the same failure class this board
// already deduped for the data-channel onmessage handler
// (src/utils/peerMessage.ts). Any future hardening of the guarded-send
// semantics (close-timing races, backpressure, error surfacing) must now
// land in exactly one place: src/utils/channelSender.ts.
//
// Two halves (matching tests/peer-message-handler.test.mjs):
//   1. The helper, exercised directly: dead channel -> send() returns false
//      WITHOUT throwing; a throwing send() -> flag flips, false returned;
//      markLost() is idempotent; isLost() reflects both flip paths.
//   2. Static source guards: BOTH components wire their sends through
//      createChannelSender(dataChannel), and NEITHER still carries its own
//      `if (connectionLost || dataChannel.readyState !== 'open')` guarded
//      send body — the copies are gone, not moved into two more helpers.
//      (A thin UI-flip wrapper around the helper in Sender.svelte is allowed
//      and separately pinned: it only mirrors the helper's lost flag into the
//      component's $state UI gate and must not re-implement the guard — see
//      tests/sender-connection-lost.test.mjs, static section.)
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// channelSender.ts has no enums or Svelte syntax, so Node's type stripping
// loads it directly (same convention as serialize.ts / crypto.ts in the
// other suites).
const { createChannelSender } = await import(join(here, '..', 'src', 'utils', 'channelSender.ts'));

// Mock RTCDataChannel: readyState flips on close() and send() throws the
// real InvalidStateError the platform raises after close(), like a browser.
function makeDataChannel() {
  let closed = false;
  return {
    readyState: 'open',
    sentMessages: [],
    send(msg) {
      if (closed) throw new DOMException('The channel is no longer open', 'InvalidStateError');
      this.sentMessages.push(msg);
    },
    close() {
      closed = true;
      this.readyState = 'closed';
    }
  };
}

// ---- Test 1: live channel -> send() delivers and returns true ----
{
  const dataChannel = makeDataChannel();
  const sender = createChannelSender(dataChannel);
  assert.equal(sender.isLost(), false, 'a fresh channel is not lost');
  assert.equal(sender.send(new Uint8Array([1, 2, 3])), true, 'a live send must succeed');
  assert.equal(dataChannel.sentMessages.length, 1, 'the payload must reach the channel');
  assert.deepEqual([...dataChannel.sentMessages[0]], [1, 2, 3]);
  assert.equal(sender.isLost(), false, 'a successful send must not flip the flag');
  console.log('ok - live channel: send() returns true, payload delivered');
}

// ---- Test 2: dead channel -> send() returns false WITHOUT throwing ----
{
  const dataChannel = makeDataChannel();
  const sender = createChannelSender(dataChannel);
  dataChannel.close();
  assert.doesNotThrow(
    () => sender.send(new Uint8Array([4, 5])),
    'a send on a dead channel must not escape InvalidStateError'
  );
  assert.equal(sender.send(new Uint8Array([4, 5])), false, 'a dead-channel send must return false');
  assert.equal(dataChannel.sentMessages.length, 0, 'nothing may be sent on the dead channel');
  console.log('ok - dead channel: send() returns false without throwing');
}

// ---- Test 3: a throwing send() flips the flag and returns false ----
{
  // The close settles asynchronously: the channel still reads 'open' when the
  // send happens, but the platform throws. The guard must catch it — the
  // mock throws on any send after close() regardless of readyState, so we
  // restore the stale 'open' read to exercise exactly that race.
  const dataChannel = makeDataChannel();
  dataChannel.close();
  dataChannel.readyState = 'open'; // the stale read: readyState not yet updated
  const sender = createChannelSender(dataChannel);
  assert.equal(sender.send(new Uint8Array([9])), false, 'a throwing send must return false');
  assert.equal(sender.isLost(), true, 'a throwing send must flip the lost flag');
  // After the flip, subsequent sends no-op without touching the channel.
  assert.equal(sender.send(new Uint8Array([9])), false, 'post-flip sends must no-op');
  assert.equal(dataChannel.sentMessages.length, 0, 'the throwing channel received nothing');
  console.log('ok - throwing send: flag flips, false returned, subsequent sends no-op');
}

// ---- Test 4: markLost() is idempotent and isLost() reflects it ----
{
  const dataChannel = makeDataChannel();
  const sender = createChannelSender(dataChannel);
  sender.markLost();
  assert.equal(sender.isLost(), true, 'markLost() must set the flag');
  sender.markLost();
  sender.markLost();
  assert.equal(sender.isLost(), true, 'markLost() must be idempotent');
  assert.equal(
    sender.send(new Uint8Array([1])),
    false,
    'a send after markLost() must return false without touching the channel'
  );
  assert.equal(dataChannel.sentMessages.length, 0, 'no send may reach a marked-lost channel');
  console.log('ok - markLost(): idempotent flip, send() no-ops afterwards');
}

// ---- Test 5: static guard — both components delegate to the shared helper ----
for (const name of ['sender/Sender.svelte', 'receiver/Receiver.svelte']) {
  const source = readFileSync(join(here, '..', 'src', 'components', name), 'utf8');
  const component = name.split('/')[1];

  assert.ok(
    source.includes("import { createChannelSender } from '../../utils/channelSender';"),
    `${component} must import createChannelSender from ../../utils/channelSender`
  );
  assert.ok(
    /createChannelSender\(dataChannel\)/.test(source),
    `${component} must build its guarded send from createChannelSender(dataChannel)`
  );
  // The deduped body is gone from the component: no copy of the guarded
  // readyState check / no own guarded send helper / no raw channel send.
  // (Mirrors how tests/peer-message-handler.test.mjs pins that the deduped
  // onmessage handler lives in exactly one place.)
  assert.ok(
    !/connectionLost\s*\|\|\s*dataChannel\.readyState\s*!==\s*'open'/.test(source),
    `${component} must no longer carry its own guarded-send body (readyState check)`
  );
  if (component === 'Sender.svelte') {
    // A thin wrapper around the helper send is allowed in the sender ONLY to
    // mirror the helper's lost flag into the component's $state UI gate
    // (pinned in tests/sender-connection-lost.test.mjs, static section). The
    // guard itself (readyState check / throwing catch / direct channel send)
    // must NOT be re-implemented here.
    assert.equal(
      (source.match(/function\s+send\s*\(\s*message:\s*Uint8Array\s*\):\s*boolean/g) || []).length,
      1,
      'Sender.svelte defines exactly one send() wrapper around the helper'
    );
    assert.ok(
      /function\s+send\s*\(\s*message:\s*Uint8Array\s*\):\s*boolean\s*\{[\s\S]{0,200}?channelSender\.send\(message\)/.test(
        source
      ),
      "Sender.svelte's send() wrapper must delegate to channelSender.send(message)"
    );
  } else {
    assert.ok(
      !/function\s+send\s*\(\s*message:\s*Uint8Array\s*\):\s*boolean/.test(source),
      `${component} must not define its own send(message): boolean — the guard lives in the shared helper`
    );
  }
  assert.equal(
    (source.match(/dataChannel\.send\(/g) || []).length,
    0,
    `${component} must not call dataChannel.send directly — every send goes through the shared helper`
  );
  console.log(`ok - ${component}: sends go through the shared channelSender helper`);
}

console.log(
  'ok - channel sender: deduped guarded send in src/utils/channelSender.ts, semantics pinned'
);
