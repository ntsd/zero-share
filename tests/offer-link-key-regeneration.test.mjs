// Regression guard for P0 "offerLink regeneration races the ICE-candidate
// timeout and re-mints the RSA keypair — encrypted transfers break when both
// paths build the link":
//   1. OfferPage.createSDPLink() used to generate a FRESH RSA keypair on every
//      call (in encryption mode) and stamp it into the link's `p` param.
//      generateOfferLink() awaits createSDPLink() from two independent async
//      paths — the onicecandidate completion and the WAIT_ICE_CANDIDATES_TIMEOUT
//      fallback — whose guard only checked `generating`, which the
//      onicecandidate path clears AFTER its awaited build. Whichever path ran
//      second minted a different keypair than the link's `p` was built from,
//      so the receiver (which imports the key from the link) could not
//      decrypt any per-file AES key and every encrypted file dead-ended with
//      no meaningful error.
//   2. The losing path additionally overwrote `offerLink` with a redundant
//      second link built off the same localDescription.
//
// The fix:
//   - mint the keypair ONCE at the top of generateOfferLink(), BEFORE
//     createPeerAndDataCannel(), and pass publicKeyBase64 into
//     createSDPLink() — which is pure URL assembly, no crypto.
//   - guard both call sites with a per-invocation local (`offerBuilt`) that
//     the first builder claims, so the link is built at most once per
//     generateOfferLink() call; a new call re-generates key + link for free.
//
// RTCPeerConnection is browser-only and cannot be exercised under Node, so
// this test (like tests/ice-server-consistency.test.mjs and
// tests/offer-processing-failure.test.mjs) is a static verification of the
// wiring:
//   1. createSDPLink() contains no generateRsaKeyPair call (keypair minted
//      once, outside the function).
//   2. generateOfferLink() mints the keypair BEFORE the peer is created.
//   3. BOTH createSDPLink call sites (onicecandidate + setTimeout) are
//      guarded so the link is built at most once per invocation.
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

// ---- Test 1: createSDPLink is pure URL assembly — no keypair minting in it ----
{
  const body = extractFunction(offerSource, 'createSDPLink');
  assert.ok(
    !body.includes('generateRsaKeyPair'),
    'createSDPLink must not mint an RSA keypair (key rotation under the link broke encrypted transfers)'
  );
  assert.ok(
    !/await\s+exportRsaPublicKeyToBase64/.test(body),
    'createSDPLink must not export the public key (crypto stays in generateOfferLink)'
  );
  assert.ok(
    /publicKeyBase64/.test(body),
    'createSDPLink must receive the public key material as a parameter'
  );
  assert.ok(
    /offerLink\s*=\s*buildURL\(/.test(body),
    'createSDPLink must still assemble the offer link via buildURL'
  );
  console.log('ok - createSDPLink is pure URL assembly; no keypair minting inside it');
}

// ---- Test 2: generateOfferLink mints the keypair once, BEFORE the peer exists ----
{
  const body = extractFunction(offerSource, 'generateOfferLink');
  const genIdx = body.search(/generateRsaKeyPair\s*\(/);
  assert.ok(
    genIdx !== -1,
    'generateOfferLink must mint the RSA keypair itself (exactly once per offer)'
  );
  const genCount = (body.match(/generateRsaKeyPair\s*\(/g) || []).length;
  assert.equal(genCount, 1, 'the keypair must be minted exactly once inside generateOfferLink');
  const exportIdx = body.search(/exportRsaPublicKeyToBase64\s*\(/);
  assert.ok(exportIdx !== -1, 'generateOfferLink must export the public key for the link');
  const peerIdx = body.search(/await\s+createPeerAndDataCannel\s*\(/);
  assert.ok(peerIdx !== -1, 'generateOfferLink must still create the peer and data channel');
  assert.ok(genIdx < peerIdx, 'the keypair must be minted BEFORE the RTCPeerConnection is created');
  assert.ok(
    exportIdx < peerIdx,
    'the public key must be exported BEFORE the RTCPeerConnection is created'
  );
  assert.ok(
    /rsa\s*=\s*await\s+generateRsaKeyPair\s*\(/.test(body),
    'the minted keypair must be stored in the `rsa` state used to encrypt outgoing files'
  );
  console.log('ok - keypair minted exactly once in generateOfferLink, before the peer is created');
}

// ---- Test 3: BOTH createSDPLink call sites are guarded — link built at most once ----
{
  // The build must live behind a per-invocation local, claimed by the first
  // builder; both call sites must sit behind that claim.
  const offerBuiltDecl = /let\s+offerBuilt\s*=\s*false/.exec(offerScript);
  assert.ok(
    offerBuiltDecl,
    'a per-invocation `let offerBuilt = false` local must exist so each generateOfferLink() call resets it'
  );
  assert.ok(
    offerBuiltDecl.index > offerSource.search(/function\s+generateOfferLink/),
    'offerBuilt must be declared inside generateOfferLink, not in createSDPLink'
  );

  // the definition is preceded by `function`; the invocations are not
  const callSites = [...offerScript.matchAll(/createSDPLink\s*\(/g)].filter(
    (m) => !/function\s*$/.test(offerScript.slice(0, m.index))
  );
  assert.ok(
    callSites.length >= 2,
    `expected both onicecandidate + setTimeout call sites to remain (found ${callSites.length})`
  );
  for (const m of callSites) {
    // the guard + the claim must both precede the call (nothing async between
    // the claim and the build, since createSDPLink is pure URL assembly)
    const before = offerScript.slice(m.index - 300, m.index);
    assert.ok(
      /offerBuilt/.test(before),
      `each createSDPLink call site must be guarded by the ${'offerBuilt'} claim (candidate vs. timeout race)`
    );
    assert.ok(
      /offerBuilt\s*=\s*true/.test(before),
      'the winning path must claim offerBuilt=true before building'
    );
    assert.ok(
      /createSDPLink\s*\([^)]*publicKeyBase64/.test(offerSource.slice(m.index, m.index + 120)),
      'each createSDPLink call must pass the hoisted publicKeyBase64 (no local re-mint)'
    );
  }

  // the timeout fallback in particular must early-return when the candidate
  // path already built the link, instead of overwriting `offerLink`
  const timeoutBody = offerScript.slice(
    offerScript.search(/setTimeout\s*\(/),
    offerScript.search(/WAIT_ICE_CANDIDATES_TIMEOUT\s*\);/)
  );
  assert.ok(
    /if\s*\([^)]*offerBuilt[^)]*\)\s*return/.test(timeoutBody),
    'the setTimeout fallback must early-return when offerBuilt is set'
  );
  const onIceBody = offerScript.slice(
    offerScript.search(/onicecandidate\s*=/),
    offerScript.search(/onicecandidate\s*=/) + 500
  );
  assert.ok(
    /!offerBuilt/.test(onIceBody),
    'the onicecandidate path must skip the build when offerBuilt is set'
  );
  console.log(
    `ok - both ${callSites.length} createSDPLink call sites are offerBuilt-guarded; the link is built at most once per offer`
  );
}

// ---- Test 4: the receiver still imports the key from the link (unchanged) ----
// The sender-side fix must not have leaked a receiver change: the `p` param
// remains the receiver's sole source of the sender's public key.
{
  const receiveSource = readFileSync(
    join(here, '..', 'src', 'components', 'ReceivePage.svelte'),
    'utf8'
  );
  assert.ok(
    /params\['p'\]/.test(receiveSource),
    "the receiver must still read the public key from the link's `p` param"
  );
  assert.ok(
    /importRsaPublicKeyFromBase64\s*\(\s*pubKeyParam/.test(receiveSource),
    'the receiver must still import the link-provided public key'
  );
  console.log("ok - receiver untouched: still imports the sender's key from the link's `p` param");
}

console.log('ok - offer-link key regeneration: keypair minted once, link built once, no race');
