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
// the same release on the channel-death path of BOTH pages:
//   1. OfferPage.svelte dataChannel.onclose AND onerror must release the
//      peer via the guarded shape
//        if (connection && connection.connectionState !== 'closed') {
//          connection.close();
//        }
//      — guarded, because close() throws InvalidStateError on an
//      already-closed peer (error-then-close double-fire, or a
//      regeneration racing the handler).
//   2. ReceivePage.svelte does the same in both handlers (its `connection`
//      is a const — const only blocks reassignment, never .close()).
//   3. OfferPage acceptAnswer() must refuse to signal a dead peer: with
//      the channel closed and the peer released, a re-pasted answer code
//      or a late QR scan must surface the known connection-lost state
//      instead of running setRemoteDescription() against a closed peer.
//
// RTCPeerConnection is browser-only and cannot be exercised under Node, so
// this test (like tests/offer-peer-lifecycle.test.mjs) is a static
// verification of the wiring.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ---- Helper: extract the arrow-function body of a dataChannel handler ----
// `dataChannel.onclose = () => { ... }` — brace-match from the `{` that
// follows `() =>`.
function extractHandler(source, handler) {
  const pattern = new RegExp(`dataChannel\\.${handler}\\s*=\\s*\\(\\)\\s*=>\\s*\\{`);
  const match = source.match(pattern);
  assert.ok(match, `dataChannel.${handler} handler must exist`);
  const braceStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new assert.AssertionError({ message: `${handler} handler: unbalanced braces` });
}

// The exact guarded release the channel-death handlers must carry.
const GUARDED_CLOSE =
  /if\s*\(\s*connection\s*&&\s*connection\.connectionState\s*!==\s*['"]closed['"]\s*\)\s*\{\s*connection\.close\(\)\s*;\s*\}/;

const offerSource = readFileSync(join(here, '..', 'src', 'components', 'OfferPage.svelte'), 'utf8');
const receiveSource = readFileSync(
  join(here, '..', 'src', 'components', 'ReceivePage.svelte'),
  'utf8'
);

// ---- Test 1: both pages release the peer in BOTH channel-death handlers ----
for (const [name, source] of [
  ['OfferPage.svelte', offerSource],
  ['ReceivePage.svelte', receiveSource]
]) {
  for (const handler of ['onclose', 'onerror']) {
    const body = extractHandler(source, handler);
    assert.ok(
      GUARDED_CLOSE.test(body),
      `${name}: dataChannel.${handler} must close the RTCPeerConnection, guarded on connectionState !== 'closed'`
    );
    // Exactly one guarded close per handler — no accidental second close.
    assert.equal(
      (body.match(/connection\.close\(\)/g) || []).length,
      1,
      `${name}: dataChannel.${handler} must release the peer exactly once`
    );
  }
  // The pipeline teardown must remain in both handlers (this fix releases
  // the peer IN ADDITION to the file-pipeline state management, not
  // instead of it).
  for (const handler of ['onclose', 'onerror']) {
    const body = extractHandler(source, handler);
    assert.ok(
      body.includes('sender?.onChannelClose();'),
      `${name}: dataChannel.${handler} must keep calling sender?.onChannelClose()`
    );
    assert.ok(
      body.includes('receiver?.onChannelClose();'),
      `${name}: dataChannel.${handler} must keep calling receiver?.onChannelClose()`
    );
  }
  console.log(`ok - ${name}: onclose/onerror both release the RTCPeerConnection (guarded)`);
}

// ---- Test 2: offer-page acceptAnswer refuses to signal a dead peer ----
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

// ---- Test 3: the peer is still created and the regeneration teardown intact ----
// The channel-death release must not have trimmed the live paths: both
// pages still construct their RTCPeerConnection, and the offer page's
// regeneration teardown still carries its own guarded close (so the page
// now has the close guarded three times: regeneration + 2 death handlers).
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
    3,
    'OfferPage.svelte must close the peer in both death handlers AND the regeneration teardown (found ' +
      (offerSource.match(/connection\.close\(\)/g) || []).length +
      ')'
  );
  assert.equal(
    (receiveSource.match(/connection\.close\(\)/g) || []).length,
    2,
    'ReceivePage.svelte must close the peer in both death handlers and nowhere else'
  );
  console.log('ok - peer creation and the regeneration teardown remain intact');
}

console.log(
  'ok - dead data channel: both peers close the RTCPeerConnection on onclose/onerror, no stale-peer signaling'
);
