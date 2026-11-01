// Regression guard for the P0 "dead data channel never closes the
// RTCPeerConnection" leak: when the channel dies (peer closed the tab,
// network drop, channel error), both pages' dataChannel.onclose/onerror
// handlers mark the file pipelines "connection lost" — but NONE of them
// ever called connection.close(). In WebRTC, closing a data channel does
// NOT close the peer: the RTCPeerConnection (its ICE agent, its UDP
// sockets, and its STUN/TURN keepalive traffic) stays open for the rest
// of the page's lifetime unless close() is called. The codebase already
// treated this exact leak as serious in the offer-page regeneration
// teardown (pinned in tests/offer-peer-lifecycle.test.mjs); this test pins
// the same release on the channel-death path of BOTH pages.
//
// The shared teardown now lives in src/utils/channelTeardown.ts
// (dedup of the two copy-pasted ~18-line blocks — see
// tests/channel-teardown.test.mjs for the runtime behavior). This test
// pins the WIRING of that helper:
//   1. BOTH pages' dataChannel.onclose AND onerror delegate to the
//      shared teardown (channelTeardown.onclose / .onerror) — and no page
//      carries its own guarded connection.close() inside a death handler
//      anymore. The guarded release lives exactly once, in the helper:
//        if (connection && connection.connectionState !== 'closed') {
//          connection.close();
//        }
//      — guarded, because close() throws InvalidStateError on an
//      already-closed peer (error-then-close double-fire, or a
//      regeneration racing the handler).
//   2. OfferPage's wiring passes a live peer getter (its `connection` is
//      reassigned to a new peer on every "Generate Offer" regeneration —
//      the helper must read it at fire time, not capture a stale peer) and
//      an onChannelLost hook that clears the dead generation's offer link.
//      ReceivePage passes the same live getters and NO onChannelLost
//      (it has no offer link).
//   3. OfferPage acceptAnswer() must refuse to signal a dead peer: with
//      the channel closed and the peer released, a re-pasted answer code
//      or a late QR scan must surface the known connection-lost state
//      instead of running setRemoteDescription() against a closed peer.
//
// RTCPeerConnection is browser-only and cannot be exercised under Node, so
// this test (like tests/offer-peer-lifecycle.test.mjs) is a static
// verification of the wiring; the helper's runtime behavior is exercised
// in tests/channel-teardown.test.mjs.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// The exact guarded release the shared teardown must carry.
const GUARDED_CLOSE =
  /if\s*\(\s*connection\s*&&\s*connection\.connectionState\s*!==\s*['"]closed['"]\s*\)\s*\{\s*connection\.close\(\)\s*;\s*\}/;

const teardownSource = readFileSync(join(here, '..', 'src', 'utils', 'channelTeardown.ts'), 'utf8');
const offerSource = readFileSync(join(here, '..', 'src', 'components', 'OfferPage.svelte'), 'utf8');
const receiveSource = readFileSync(
  join(here, '..', 'src', 'components', 'ReceivePage.svelte'),
  'utf8'
);

// ---- Test 1: the guarded peer release lives in the shared helper, once ----
// Count only CODE lines: the guarded shape is also quoted in this module's
// doc comment (a comment line would otherwise inflate the count).
const teardownCode = teardownSource
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');
{
  assert.ok(
    GUARDED_CLOSE.test(teardownSource),
    "channelTeardown.ts must close the RTCPeerConnection, guarded on connectionState !== 'closed'"
  );
  assert.equal(
    (teardownCode.match(/connection\.close\(\)/g) || []).length,
    1,
    'channelTeardown.ts must release the peer exactly once'
  );
  console.log('ok - the guarded peer release lives exactly once in the shared helper');
}

// ---- Test 2: both pages route channel death through the shared helper ----
// Both dataChannel.onclose and dataChannel.onerror must delegate to the
// helper's handlers, and neither page may keep its own copy of the
// teardown body (the copy-paste that produced the original P0 leak and
// every stale-gate desync since).
for (const [name, source, teardownVar] of [
  ['OfferPage.svelte', offerSource, 'channelTeardown'],
  ['ReceivePage.svelte', receiveSource, 'channelTeardown']
]) {
  assert.ok(
    source.includes("import { createChannelTeardown } from '../utils/channelTeardown';"),
    `${name} must import createChannelTeardown from ../utils/channelTeardown`
  );
  for (const handler of ['onclose', 'onerror']) {
    const assignIdx = source.indexOf(`dataChannel.${handler} = `);
    assert.ok(assignIdx !== -1, `${name}: dataChannel.${handler} must still be wired`);
    const rest = source.slice(assignIdx, assignIdx + 120);
    assert.ok(
      rest.includes(`${teardownVar}.${handler}`),
      `${name}: dataChannel.${handler} must delegate to the shared teardown (${teardownVar}.${handler})`
    );
    // no inline arrow body — the handler body must not be copy-pasted back
    assert.ok(
      !/\)\s*=>\s*{/.test(rest),
      `${name}: dataChannel.${handler} must not carry an inline handler body copy`
    );
  }
  // The death-handler copies are GONE: no page-local guarded close remains
  // in a death handler, and the toast strings belong to the helper, not the
  // pages. (The guarded shape may still appear in the offer page's OWN
  // regeneration teardown + offer-creation catch — the counts in Test 7
  // pin exactly where; the delegation assertions above pin that the death
  // handlers themselves carry no inline body.)
  assert.ok(
    !source.includes("'WebRTC error'"),
    `${name}: the 'WebRTC error' toast belongs to the shared helper`
  );
  assert.ok(
    !source.includes("'Disconnected'"),
    `${name}: the 'Disconnected' toast belongs to the shared helper`
  );
  console.log(`ok - ${name}: onclose/onerror both delegate to the shared teardown`);
}

// ---- Test 3: OfferPage wiring passes the live peer + the link-clear hook ----
// `connection` is a `let` reassigned on every "Generate Offer"
// regeneration, so the helper must read it at fire time (a getter closure),
// not capture the first peer; and OfferPage is the only page with an
// onChannelLost hook — the dead generation's offer link must be cleared, or
// the "2. Accept Answer" section would stay open on a dead SDP.
{
  const createIdx = offerSource.search(/createChannelTeardown\(/);
  assert.ok(createIdx !== -1, 'OfferPage must call createChannelTeardown(...)');
  // isolate the options object: brace-match from the `{` after `(`
  const braceStart = offerSource.indexOf('{', createIdx);
  let depth = 0;
  let options = '';
  for (let i = braceStart; i < offerSource.length; i++) {
    if (offerSource[i] === '{') depth++;
    else if (offerSource[i] === '}') {
      depth--;
      if (depth === 0) {
        options = offerSource.slice(braceStart, i + 1);
        break;
      }
    }
  }
  assert.ok(options.length > 0, 'OfferPage: unbalanced braces in the teardown options');
  assert.ok(
    /getConnection\s*:\s*\(\)\s*=>\s*connection/.test(options),
    'OfferPage must pass a live peer getter (`getConnection: () => connection`) — `connection` is reassigned on every regeneration and must be read at fire time'
  );
  assert.ok(
    /getSender\s*:\s*\(\)\s*=>\s*sender/.test(options),
    'OfferPage must pass the Sender ref live (`getSender: () => sender`)'
  );
  assert.ok(
    /getReceiver\s*:\s*\(\)\s*=>\s*receiver/.test(options),
    'OfferPage must pass the Receiver ref live (`getReceiver: () => receiver`)'
  );
  assert.ok(
    /markNotConnecting\s*:\s*\(\)\s*=>\s*\{\s*isConnecting\s*=\s*false\s*;/.test(options),
    'OfferPage must reset isConnecting = false when the channel dies'
  );
  assert.ok(
    /onChannelLost\s*:\s*\(\)\s*=>\s*\{\s*offerLink\s*=\s*''\s*;/.test(options),
    "OfferPage must clear the dead generation's offer link via the onChannelLost hook"
  );
  console.log('ok - OfferPage wiring: live peer getter + sender/receiver + offerLink clear');
}

// ---- Test 4: ReceivePage wiring passes the live peer, no link hook ----
{
  const createIdx = receiveSource.search(/createChannelTeardown\(/);
  assert.ok(createIdx !== -1, 'ReceivePage must call createChannelTeardown(...)');
  const braceStart = receiveSource.indexOf('{', createIdx);
  let depth = 0;
  let options = '';
  for (let i = braceStart; i < receiveSource.length; i++) {
    if (receiveSource[i] === '{') depth++;
    else if (receiveSource[i] === '}') {
      depth--;
      if (depth === 0) {
        options = receiveSource.slice(braceStart, i + 1);
        break;
      }
    }
  }
  assert.ok(options.length > 0, 'ReceivePage: unbalanced braces in the teardown options');
  assert.ok(
    /getConnection\s*:\s*\(\)\s*=>\s*connection/.test(options),
    'ReceivePage must pass the peer live (`getConnection: () => connection`) even though it is a const'
  );
  assert.ok(
    /getSender\s*:\s*\(\)\s*=>\s*sender/.test(options),
    'ReceivePage must pass the Sender ref live'
  );
  assert.ok(
    /getReceiver\s*:\s*\(\)\s*=>\s*receiver/.test(options),
    'ReceivePage must pass the Receiver ref live'
  );
  assert.ok(
    /markNotConnecting\s*:\s*\(\)\s*=>\s*\{\s*isConnecting\s*=\s*false\s*;/.test(options),
    'ReceivePage must reset isConnecting = false when the channel dies'
  );
  assert.ok(
    !options.includes('onChannelLost'),
    'ReceivePage must not pass an onChannelLost hook (it has no offer link to clear)'
  );
  console.log('ok - ReceivePage wiring: live peer getter, no offer-link hook');
}

// ---- Test 5: the pipeline propagation still reaches both sides ----
// The death path must keep propagating "connection lost" into BOTH file
// pipelines (this fix releases the peer IN ADDITION to the file-pipeline
// state management, not instead of it).
{
  assert.ok(
    teardownSource.includes('getSender()?.onChannelClose();') &&
      teardownSource.includes('getReceiver()?.onChannelClose();'),
    'channelTeardown.ts must propagate "connection lost" into both the Sender and the Receiver pipelines'
  );
  console.log('ok - the onChannelClose() pipeline propagation still exists in the shared helper');
}

// ---- Test 6: offer-page acceptAnswer refuses to signal a dead peer ----
// Once the channel-death handler has closed the peer, a re-pasted answer
// code or a late QR scan must surface the connection-lost state instead of
// running setRemoteDescription() against a closed peer (which would only
// fail with a misleading "Invalid answer code").
{
  const start = offerSource.search(/function\s+acceptAnswer\s*\(/);
  assert.ok(start !== -1, 'acceptAnswer() must exist');
  const braceStart = offerSource.indexOf('{', start);
  let depth = 0;
  let body = '';
  for (let i = braceStart; i < offerSource.length; i++) {
    if (offerSource[i] === '{') depth++;
    else if (offerSource[i] === '}') {
      depth--;
      if (depth === 0) {
        body = offerSource.slice(braceStart, i + 1);
        break;
      }
    }
  }
  assert.ok(body.length > 0, 'acceptAnswer(): unbalanced braces');

  const guardIdx = body.search(
    /if\s*\(\s*(!connection\s*&&|.*connection\.connectionState\s*===\s*['"]closed['"])\s*\)/
  );
  assert.ok(
    guardIdx !== -1,
    "acceptAnswer must bail when the peer is missing or in the 'closed' state"
  );
  const sdpIdx = body.search(/setRemoteDescription\s*\(/);
  assert.ok(sdpIdx !== -1, 'acceptAnswer must still call setRemoteDescription for a live peer');
  assert.ok(guardIdx < sdpIdx, 'the dead-peer guard must run before setRemoteDescription');
  console.log('ok - OfferPage.svelte: acceptAnswer refuses to signal a dead peer');
}

// ---- Test 7: the peer is still created and the regeneration teardown intact ----
// The channel-death release must not have trimmed the live paths: both
// pages still construct their RTCPeerConnection, and the offer page's
// regeneration teardown + offer-creation catch still carry their own
// guarded closes (the page now closes the peer in exactly those two
// places; the two death handlers now delegate to the helper).
{
  assert.ok(
    /new\s+RTCPeerConnection\(/.test(offerSource),
    'OfferPage.svelte must still create the RTCPeerConnection'
  );
  assert.ok(
    /const\s+connection\s*=\s*new\s+RTCPeerConnection\(/.test(receiveSource),
    'ReceivePage.svelte must still create the RTCPeerConnection'
  );
  assert.equal(
    (offerSource.match(/connection\.close\(\)/g) || []).length,
    2,
    'OfferPage.svelte must close the peer in the regeneration teardown AND the offer-creation catch only (the death handlers now live in the helper); found ' +
      (offerSource.match(/connection\.close\(\)/g) || []).length
  );
  assert.equal(
    (receiveSource.match(/connection\.close\(\)/g) || []).length,
    0,
    'ReceivePage.svelte must not close the peer locally — its death handlers delegate to the helper'
  );
  console.log('ok - peer creation and the regeneration teardown remain intact');
}

console.log(
  'ok - dead data channel: both pages route channel death through the shared teardown, guarded peer close + pipeline propagation live in the helper'
);
