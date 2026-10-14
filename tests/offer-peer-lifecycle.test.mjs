// Regression guard for P0 "regenerating the offer leaks the previous
// RTCPeerConnection and its ICE-candidate timeout can build a link with the
// previous generation's RSA public key":
//   1. generateOfferLink() re-created the RTCPeerConnection + RTCDataChannel
//      on every "Generate Offer" click without ever closing the previous
//      ones. Each regeneration leaked a live peer (ICE agent, UDP sockets,
//      STUN traffic), and the abandoned channel's onopen/onerror/onclose
//      handlers kept firing for a later generation — onopen set
//      isConnecting, onerror/onclose cleared the NEW session's offerLink.
//   2. The WAIT_ICE_CANDIDATES_TIMEOUT fallback captured that generation's
//      local publicKeyBase64 but read the SCRIPT-scope `connection` and
//      `generating` at fire time. Regenerating before the timeout fired let
//      the stale timer pass its guard against the NEW peer's
//      localDescription and build a link whose `p` key belonged to the OLD
//      generation — while `rsa` (the private key) had already been re-minted.
//      The peer then could not decrypt the AES key and every encrypted
//      transfer broke, silently.
//
// The fix:
//   - at the top of generateOfferLink(), before the new keypair is minted
//     and the new peer created: clear the previous generation's pending
//     ICE-candidate timer (id tracked in the script-scope
//     `iceCandidateTimer`), detach the handlers of the old data channel and
//     close it, and close the old RTCPeerConnection (guarded, because
//     close() throws on an already-closed peer).
//   - a monotonic script-scope `offerGeneration` counter is captured into a
//     per-invocation local; the fallback timer re-checks the token at fire
//     time, so even a timer that survives a clearTimeout window can never
//     build a link for a generation that no longer owns `connection`.
//
// RTCPeerConnection is browser-only and cannot be exercised under Node, so
// this test (like tests/offer-processing-failure.test.mjs and
// tests/offer-link-key-regeneration.test.mjs) is a static verification of
// the wiring:
//   1. generateOfferLink tears down the previous generation (clear the
//      timer, close the data channel with handlers detached, close the
//      peer) BEFORE minting the keypair and creating the new peer.
//   2. the ICE-candidate fallback timer id is stored in a script-scope
//      variable and cleared on the next generation; the callback is
//      generation-token-guarded, and no bare setTimeout remains in the
//      generation flow.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ---- Helper: find the body of a named function in Svelte source ----
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

const offerSource = readFileSync(join(here, '..', 'src', 'components', 'OfferPage.svelte'), 'utf8');
const offerScript = offerSource.slice(0, offerSource.indexOf('</script>'));
const genBody = extractFunction(offerSource, 'generateOfferLink');
const peerBody = extractFunction(offerSource, 'createPeerAndDataCannel');

// ---- Test 1: the previous generation is torn down before the new peer exists ----
// Every regeneration used to leave the old RTCPeerConnection and its data
// channel live; the teardown must run BEFORE the new keypair is minted and
// the new peer is created, so the old generation's handlers can never touch
// the new session's state.
{
  const peerIdx = genBody.search(/await\s+createPeerAndDataCannel\s*\(/);
  assert.ok(peerIdx !== -1, 'generateOfferLink must still create the peer and data channel');
  const mintIdx = genBody.search(/generateRsaKeyPair\s*\(/);
  assert.ok(mintIdx !== -1, 'generateOfferLink must still mint the RSA keypair');

  const clearTimeoutIdx = genBody.search(/clearTimeout\(\s*iceCandidateTimer\s*\)/);
  assert.ok(
    clearTimeoutIdx !== -1,
    "generateOfferLink must clearTimeout the previous generation's pending ICE-candidate timer"
  );
  assert.ok(
    clearTimeoutIdx < mintIdx,
    "the previous generation's timer must be cancelled before the new keypair is minted"
  );

  const channelCloseIdx = genBody.search(/dataChannel\.close\(\)/);
  assert.ok(channelCloseIdx !== -1, 'generateOfferLink must close the previous data channel');
  assert.ok(
    channelCloseIdx < peerIdx,
    'the previous data channel must be closed before the new peer is created'
  );
  for (const handler of ['onopen', 'onmessage', 'onerror', 'onclose']) {
    const detachIdx = genBody.search(new RegExp(`dataChannel\\.${handler}\\s*=\\s*null`));
    assert.ok(detachIdx !== -1, `the previous channel's ${handler} handler must be detached`);
    assert.ok(
      detachIdx < channelCloseIdx,
      `the ${handler} handler must be detached before dataChannel.close()`
    );
  }
  const channelResetIdx = genBody.search(/dataChannel\s*=\s*undefined/);
  assert.ok(
    channelResetIdx !== -1 && channelResetIdx > channelCloseIdx,
    'dataChannel must be reset to undefined after closing so the template drops the dead channel'
  );

  const peerCloseIdx = genBody.search(/connection\.close\(\)/);
  assert.ok(peerCloseIdx !== -1, 'generateOfferLink must close the previous RTCPeerConnection');
  assert.ok(
    peerCloseIdx < peerIdx,
    'the previous RTCPeerConnection must be closed before the new one is created'
  );
  // close() throws InvalidStateError on an already-closed peer — the call
  // must be guarded, otherwise a second regeneration after a settled peer
  // would surface an unhandled error and skip the new peer creation
  assert.ok(
    /connectionState\s*!==\s*['"]closed['"]/.test(genBody),
    'the previous peer must only be closed when it is not already in the closed state'
  );
  console.log(
    'ok - generateOfferLink tears down the previous generation before creating the new peer'
  );
}

// ---- Test 2: the fallback timer is tracked at script scope and cleared per generation ----
// The id must live outside the per-invocation locals so the NEXT
// generateOfferLink() can cancel the timer still pending from this call.
{
  const declIdx = offerScript.search(/let\s+iceCandidateTimer\s*:/);
  assert.ok(declIdx !== -1, 'the pending timer id must be declared in script scope (not a local)');
  const funcIdx = offerScript.search(/function\s+generateOfferLink/);
  assert.ok(declIdx < funcIdx, 'iceCandidateTimer must be declared before generateOfferLink');

  const assignIdx = genBody.search(/iceCandidateTimer\s*=\s*setTimeout\(/);
  assert.ok(
    assignIdx !== -1,
    'the ICE-candidate fallback timer id must be stored in the script-scope variable'
  );
  const bareTimeouts = (genBody.match(/setTimeout\(/g) || []).length;
  assert.equal(
    bareTimeouts,
    1,
    'generateOfferLink must schedule exactly one timer, and it must be the tracked one'
  );
  const peerIdx = genBody.search(/await\s+createPeerAndDataCannel\s*\(/);
  assert.ok(
    assignIdx > peerIdx,
    'the fallback timer must be scheduled after the new peer exists (as before)'
  );
  console.log('ok - the ICE-candidate fallback timer id is tracked and cleared per generation');
}

// ---- Test 3: the stale-timer defense — a generation token guards the fallback ----
// Even if a timer from generation N somehow survived generation N+1's
// clearTimeout (e.g. scheduled after it ran), its closure still holds
// generation N's publicKeyBase64 — the token check must stop it from
// building a link whose `p` key no longer matches the re-minted `rsa`.
{
  const counterIdx = offerScript.search(/let\s+offerGeneration\s*=/);
  assert.ok(
    counterIdx !== -1 && counterIdx < offerScript.search(/function\s+generateOfferLink/),
    'a script-scope offer-generation counter must exist'
  );
  assert.ok(
    /offerGeneration\s*\+\+/.test(genBody),
    'generateOfferLink must advance the generation counter on every call'
  );
  assert.ok(
    /const\s+generation\s*=\s*offerGeneration/.test(genBody),
    'each invocation must capture its generation into a local before the async work'
  );
  const assignIdx = genBody.search(/iceCandidateTimer\s*=\s*setTimeout\(/);
  const tokenGuardIdx = genBody.search(
    /if\s*\(\s*generation\s*!==\s*offerGeneration\s*\)\s*return/
  );
  assert.ok(
    tokenGuardIdx !== -1,
    'the fallback timer callback must early-return when its generation is stale'
  );
  assert.ok(
    tokenGuardIdx > assignIdx,
    'the generation check must live inside the fallback timer callback'
  );
  console.log("ok - a stale-generation timer cannot build a link off the new peer's SDP");
}

// ---- Test 4: the generation flow is intact — peer creation and both build paths remain ----
// The teardown must not have over-trimmed the working paths: the peer is
// still created, and the onicecandidate completion + timeout fallback still
// build the link under the per-invocation offerBuilt claim.
{
  assert.ok(
    /new\s+RTCPeerConnection\(/.test(peerBody),
    'createPeerAndDataCannel must still create the RTCPeerConnection'
  );
  const callSites = [...offerScript.matchAll(/createSDPLink\s*\(/g)].filter(
    (m) => !/function\s*$/.test(offerScript.slice(0, m.index))
  );
  assert.ok(
    callSites.length >= 2,
    `both link-build call sites must remain (found ${callSites.length})`
  );
  assert.ok(
    /let\s+offerBuilt\s*=\s*false/.test(genBody),
    'the per-invocation offerBuilt claim must still guard the two build paths'
  );
  console.log('ok - peer creation and both offer-link build paths remain intact');
}

console.log(
  'ok - offer peer lifecycle: no leaked RTCPeerConnection, no stale-timer key desync on regeneration'
);
