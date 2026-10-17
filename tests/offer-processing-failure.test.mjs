// Regression guard for P0 "receive page dead-ends on any offer-processing
// failure — swallowed setRemoteDescription error + unhandled createAnswer
// rejection leaves spinner forever":
//   1. ReceivePage.svelte setOfferSDP() caught ALL failures (bad sdpDecode
//      AND a rejected setRemoteDescription) and only toasted — the
//      connection stayed in `stable` signaling state.
//   2. generateAnswerSDP() was called fire-and-forget with no .catch; because
//      WebRTC serializes queued operations, createAnswer() then rejected with
//      InvalidStateError as an UNHANDLED rejection and the "Generating
//      Answer" spinner ran forever.
//   3. OfferPage.svelte generateOfferLink() awaited createPeerAndDataCannel()
//      (which can throw synchronously from `new RTCPeerConnection` /
//      `createDataChannel`) with no try/catch — unhandled rejection, no toast,
//      and `generating` stuck true so the button stayed dead.
//
// RTCPeerConnection is browser-only and cannot be exercised under Node, so
// this test (like tests/sdp-robustness.test.mjs) is scoped to a static
// verification of the wiring:
//   1. ReceivePage.svelte retains the setOfferSDP promise in a
//      module-scope const (not fire-and-forget) and generateAnswerSDP
//      awaits it BEFORE createAnswer, with a signalingState guard that
//      early-returns out of the failure path.
//   2. The fire-and-forget generateAnswerSDP() call site has a .catch that
//      surfaces the distinct 'Could not connect: offer from the sender is
//      invalid' toast, and the template renders an error state (not the
//      spinner) when the offer failed.
//   3. OfferPage.svelte generateOfferLink() wraps the whole peer/offer setup
//      (createPeerAndDataCannel + createOffer + setLocalDescription)
//      in a try/catch that resets generating=false and toasts.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ---- Helper: find the body of a named async function in Svelte source ----
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

const receiveSource = readFileSync(
  join(here, '..', 'src', 'components', 'ReceivePage.svelte'),
  'utf8'
);
const offerSource = readFileSync(join(here, '..', 'src', 'components', 'OfferPage.svelte'), 'utf8');
const receiveScript = receiveSource.slice(0, receiveSource.indexOf('</script>'));

// ---- Test 1: setOfferSDP's promise is retained, not fire-and-forget ----
// A bare `setOfferSDP(sdpEncoded);` statement would queue createAnswer behind
// a rejected setRemoteDescription -> unhandled InvalidStateError rejection.
{
  const storeRe = /const\s+(\w+)\s*(?::\s*Promise<[^>]*>)?\s*=\s*setOfferSDP\(\s*sdpEncoded\s*\)/;
  const m = receiveScript.match(storeRe);
  assert.ok(m, 'setOfferSDP(sdpEncoded) must be assigned to a module-scope const promise');
  const promiseVar = m[1];
  // The promise must not have a detached .catch that would mask the failure:
  // the failure has to stay visible to generateAnswerSDP via the state flag.
  assert.ok(
    !receiveScript.includes(`${promiseVar}.catch`),
    'the setOfferSDP promise must not be masked by a bare .catch at the call site'
  );
  console.log(`ok - ReceivePage.svelte: setOfferSDP promise retained in \`${promiseVar}\``);

  // ---- Test 2: generateAnswerSDP awaits the offer-settling BEFORE createAnswer ----
  const body = extractFunction(receiveSource, 'generateAnswerSDP');
  const awaitIdx = body.indexOf(`await ${promiseVar}`);
  assert.ok(awaitIdx !== -1, 'generateAnswerSDP must await the setOfferSDP promise');
  const guardIdx = body.search(/signalingState\s*!==\s*['"]have-remote-offer['"]/);
  assert.ok(
    guardIdx !== -1,
    'generateAnswerSDP must guard on signalingState !== have-remote-offer'
  );
  const createAnswerIdx = body.search(/await\s+connection\.createAnswer\(/);
  assert.ok(createAnswerIdx !== -1, 'generateAnswerSDP must still createAnswer on the happy path');
  assert.ok(
    awaitIdx < guardIdx && guardIdx < createAnswerIdx,
    'the offer-settling await and the signaling-state guard must both run before createAnswer'
  );
  console.log(
    'ok - generateAnswerSDP awaits offer-settling + signaling-state guard before createAnswer'
  );
}

// ---- Test 3: the fire-and-forget call site never rejects unhandled ----
{
  assert.ok(
    /generateAnswerSDP\(\)\s*\.catch\(/.test(receiveScript),
    'generateAnswerSDP() call site must attach a .catch'
  );
  assert.ok(
    /addToastMessage\s*\(\s*['"]Could not connect: offer from the sender is invalid['"]\s*,\s*['"]error['"]/.test(
      receiveScript
    ),
    'the failure must surface the distinct "Could not connect: offer from the sender is invalid" toast'
  );
  console.log('ok - generateAnswerSDP() call site is .catch-ed with a distinct error toast');
}

// ---- Test 4: the spinner is replaced by an error state when the offer fails ----
// `answerSDP` stays empty on failure, so without a dedicated branch the
// template would render the "Generating Answer" spinner forever.
{
  const markup = receiveSource.slice(receiveSource.indexOf('</script>'));
  assert.ok(
    /let\s+offerFailed\s*=/.test(receiveScript),
    'ReceivePage must have an offerFailed state'
  );
  assert.ok(
    /setOfferSDP[\s\S]*?offerFailed\s*=\s*true/.test(receiveScript),
    'setOfferSDP must flag offerFailed on failure'
  );
  assert.ok(
    /\{:else\s+if\s+offerFailed\}/.test(markup),
    'the Answer template must branch on offerFailed so the spinner does not run forever'
  );
  assert.ok(/text-error/.test(markup), 'the offer-failure branch must render error-styled text');
  console.log('ok - ReceivePage template: offer failure renders an error state, not the spinner');
}

// ---- Test 5: OfferPage.generateOfferLink guards the whole setup flow ----
{
  const body = extractFunction(offerSource, 'generateOfferLink');
  const tryRe = /try\s*{([\s\S]*?)}\s*catch\s*(?:\([^)]*\))?\s*{([\s\S]*?)}/g;
  let m;
  let found = null;
  while ((m = tryRe.exec(body)) !== null) {
    const [tryBody, catchBody] = [m[1], m[2]];
    if (/await\s+createPeerAndDataCannel\(/.test(tryBody) && /createOffer\(/.test(tryBody)) {
      found = { tryBody, catchBody };
    }
  }
  assert.ok(
    found,
    'generateOfferLink: a try/catch must wrap createPeerAndDataCannel + createOffer'
  );
  assert.ok(
    /generating\s*=\s*false/.test(found.catchBody),
    'generateOfferLink catch must reset generating=false so the button is usable again'
  );
  assert.ok(
    /addToastMessage\s*\([^;]*'error'/.test(found.catchBody),
    'generateOfferLink catch must surface an error toast'
  );
  console.log(
    'ok - OfferPage.svelte: generateOfferLink guards the setup flow, resets generating, toasts'
  );
}

// ---- Test 6: the dead generation's offer link is cleared on regeneration ----
// generateOfferLink() tears down the previous RTCPeerConnection + data channel
// and re-mints the RSA keypair, but the OLD link's SDP belongs to that closed
// peer and its `p` key to the keypair about to be re-minted — a dead,
// unshareable link. If offerLink is not reset during the teardown, the
// "2. Accept Answer" section (keyed on `offerLink !== ''`) keeps rendering the
// dead link as copyable/QR'able for the whole regeneration window (the
// ICE-candidate wait plus async setup), and a FAILED regeneration strands it as
// the primary share artifact. The reset must live in the teardown block, BEFORE
// the new generation's try/catch — i.e. before `generating = true` — not only
// in the catch: a catch-only reset would leave the success-path stale window
// and the reset-to-empty-string matters because the template keys on
// `offerLink !== ''` (an `undefined` reset would leave the section open).
{
  const body = extractFunction(offerSource, 'generateOfferLink');
  const resetIdx = body.search(/offerLink\s*=\s*''/);
  assert.ok(
    resetIdx !== -1,
    "generateOfferLink must reset offerLink = '' so a dead generation's link is not left presented"
  );
  const generatingIdx = body.search(/generating\s*=\s*true/);
  assert.ok(generatingIdx !== -1, 'generateOfferLink must set generating = true');
  assert.ok(
    resetIdx < generatingIdx,
    "the offerLink = '' reset must run in the teardown block BEFORE generating=true (not only in the catch), so a failed or in-flight regeneration never presents the dead link"
  );
  console.log(
    "ok - generateOfferLink clears the dead generation's offer link before minting the new one"
  );
}

console.log(
  'ok - offer-processing failure: no eternal spinner, no unhandled rejection, recovery state on both pages'
);
