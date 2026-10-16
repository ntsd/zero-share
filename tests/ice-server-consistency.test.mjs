// Regression guard for P1 "custom/TURN ICE server chosen on the sender is
// silently dropped on the receiver — asymmetric ICE servers break NAT
// traversal".
//
// The sender (OfferPage) lets the user pick ANY STUN/TURN/ICE server (custom
// free text in OfferOptions) and encodes it into the `i` URL param of the
// shared offer link; the receiver (ReceivePage) must configure its
// RTCPeerConnection with the SAME value. Commit #45 introduced a fixed
// STUN_SERVERS allowlist on the receive side only, so a custom/TURN server
// survived on the offer side but was silently replaced by the default on the
// answer side — the two peers ran asymmetric ICE with no user-visible
// feedback.
//
// The fix enforces a single shared predicate (isSupportedIceServer) and
// resolver (resolveIceServer) in src/configs.ts on BOTH sides:
//   - OfferPage: what the RTCPeerConnection uses AND what goes into `i`
//     both come from resolveIceServer(sendOptions.iceServer).
//   - ReceivePage: the `i` param is accepted when isSupportedIceServer
//     passes, otherwise it downgrades to the default with a visible toast.
//
// This test verifies:
//   1. Round-trip through the REAL src/configs.ts + src/utils/path.ts:
//      for every value the sender may emit into `i` (default, every
//      STUN_SERVERS entry, valid custom stun:/turn: URLs) the value the
//      receiver resolves from the decoded link equals the value the sender
//      configured its RTCPeerConnection with.
//   2. Adversarial `i` values (no scheme, javascript:, empty host, ...) are
//      rejected by the shared predicate on both sides, so they can never
//      create an asymmetric pair — sender warns + falls back, receiver
//      downgrades + toasts.
//   3. Both Svelte components still route their ICE-server decisions through
//      the shared helpers (static check, mirroring sdp-robustness.test.mjs)
//      and the receive side surfaces a toast instead of downgrading silently.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Node 22+ strips types natively, so exercise the REAL shared predicate and
// URL builders instead of copies that could drift from the source.
const { STUN_SERVERS, DEFAULT_SEND_OPTIONS, isSupportedIceServer, resolveIceServer } = await import(
  join(here, '..', 'src', 'configs.ts')
);
const { buildURL } = await import(join(here, '..', 'src', 'utils', 'path.ts'));

// Simulate exactly what OfferPage.createSDPLink does with the `i` param and
// what buildURL does with empty values, then decode the way
// ReceivePage reads the URL: `new URLSearchParams(location.search)`.
function roundTripLink(chosenIceServer) {
  const iceServer = resolveIceServer(chosenIceServer); // sender's resolution
  const url = buildURL('https://zero.example/', 'receive', {
    s: 'sdp',
    i: DEFAULT_SEND_OPTIONS.iceServer === iceServer ? '' : iceServer,
    c: '',
    p: ''
  });
  const search = url.slice(url.indexOf('?') + 1);
  const iceParam = new URLSearchParams(search).get('i'); // receiver's input
  const receiverIceServer = resolveIceServer(iceParam); // receiver's resolution
  return { senderIceServer: iceServer, receiverIceServer };
}

// ---- Test 1: default case — no `i` param, receiver keeps the default ----
{
  const { senderIceServer, receiverIceServer } = roundTripLink(DEFAULT_SEND_OPTIONS.iceServer);
  assert.equal(senderIceServer, DEFAULT_SEND_OPTIONS.iceServer);
  assert.equal(receiverIceServer, DEFAULT_SEND_OPTIONS.iceServer);
  assert.equal(senderIceServer, receiverIceServer, 'default path must be symmetric');
  console.log('ok - default ICE server round-trips symmetrically through the link');
}

// ---- Test 2: custom/TURN case — every server the sender may emit is honored verbatim ----
{
  // The full universe of values OfferOptions can hand to the sender: the
  // allowlist entries plus well-formed custom stun:/turn: URLs (incl. the
  // reproduction case from the P1 report).
  const customCases = [
    'turn:turn.example.com:3478?transport=udp',
    'turn:turn.example.com:3478?transport=tcp&username=me&password=s3cret',
    'stun:stun.custom-isp.example:3478',
    'stuns:stun.nextcloud.com:443'
  ];
  for (const server of [...STUN_SERVERS, ...customCases]) {
    assert.ok(
      isSupportedIceServer(server),
      `predicate must accept sender-emittable value ${JSON.stringify(server)}`
    );
    const { senderIceServer, receiverIceServer } = roundTripLink(server);
    assert.equal(senderIceServer, server, `sender must use ${JSON.stringify(server)}`);
    assert.equal(
      receiverIceServer,
      senderIceServer,
      `receiver must honor the sender's ${JSON.stringify(server)}, got ${JSON.stringify(receiverIceServer)}`
    );
  }
  console.log(
    `ok - custom/TURN ICE servers round-trip symmetrically (${STUN_SERVERS.length} allowlist + ${customCases.length} custom)`
  );
}

// ---- Test 3: adversarial `i` values cannot create an asymmetric pair ----
{
  const adversarial = [
    undefined, // no `i` param at all
    '', // empty param
    'stun:', // empty host
    'stun: ', // whitespace host
    'https://evil.example', // wrong scheme
    'javascript:alert(1)',
    'stun:a b.example.com', // whitespace inside host
    'ev il.example.com:3478', // no scheme
    'STUN://', // not a valid ice scheme
    'stun:x\nexample.com' // newline
  ];
  for (const bad of adversarial) {
    assert.equal(isSupportedIceServer(bad), false, `predicate must reject ${JSON.stringify(bad)}`);
    const { senderIceServer, receiverIceServer } = roundTripLink(bad ?? undefined);
    assert.equal(senderIceServer, DEFAULT_SEND_OPTIONS.iceServer);
    assert.equal(receiverIceServer, DEFAULT_SEND_OPTIONS.iceServer);
    assert.equal(senderIceServer, receiverIceServer, 'both sides must agree on the fallback');
  }
  console.log(
    `ok - ${adversarial.length} adversarial values are rejected on both sides (no asymmetric pair)`
  );
}

// ---- Test 4: the Svelte pages route their ICE-server decisions through the shared helpers ----
{
  const receiveSource = readFileSync(
    join(here, '..', 'src', 'components', 'ReceivePage.svelte'),
    'utf8'
  );
  const offerSource = readFileSync(
    join(here, '..', 'src', 'components', 'OfferPage.svelte'),
    'utf8'
  );

  // Receive side: the old fixed-allowlist check is gone and the shared
  // predicate decides; a visible toast surfaces any downgrade.
  assert.ok(
    !/STUN_SERVERS\.includes/.test(receiveSource),
    'ReceivePage must not hard-code its own STUN allowlist check'
  );
  assert.ok(
    /isSupportedIceServer\(\s*iceParam\s*\)/.test(receiveSource),
    'ReceivePage must validate the `i` param with the shared isSupportedIceServer predicate'
  );
  assert.ok(
    /addToastMessage\(\s*`[^`]*Invalid ICE server in link[^`]*`/.test(receiveSource),
    'ReceivePage must surface a toast when the link ICE server is downgraded'
  );
  assert.ok(
    /iceServers:\s*\[\{\s*urls:\s*iceServer\s*\}\]/.test(receiveSource),
    'ReceivePage RTCPeerConnection must use the validated iceServer variable'
  );

  // Offer side: BOTH the `i` link param and the local RTCPeerConnection must
  // come from the same resolver, so the advertised server is the used server;
  // a chosen value that the resolver downgrades surfaces a visible toast.
  const linkParamRe =
    /i:\s*DEFAULT_SEND_OPTIONS\.iceServer\s*===\s*iceServer\s*\?\s*''\s*:\s*iceServer/;
  const peerRe = /iceServers:\s*\[\{\s*urls:\s*iceServer\s*\}\]/;
  assert.ok(
    linkParamRe.test(offerSource),
    'OfferPage must emit the `i` link param from the shared-resolved iceServer variable'
  );
  assert.ok(
    peerRe.test(offerSource),
    'OfferPage RTCPeerConnection must use the shared-resolved iceServer variable'
  );
  assert.ok(
    !/iceServers:\s*\[\{\s*urls:\s*sendOptions\.iceServer/.test(offerSource),
    'OfferPage RTCPeerConnection must not use the raw user-typed value'
  );
  assert.ok(
    /sendOptions\.iceServer\s*!==\s*resolveIceServer\(sendOptions\.iceServer\)/.test(offerSource),
    'OfferPage must compare the raw chosen value against the resolver to detect a downgrade'
  );
  assert.ok(
    /addToastMessage\(\s*`[^`]*Invalid ICE server, using default/.test(offerSource),
    'OfferPage must surface a toast when a chosen custom server is downgraded'
  );

  console.log(
    'ok - both Svelte pages resolve the ICE server through the shared predicate/resolver'
  );
}

console.log('ok - ICE server consistency: sender link and receiver config always agree');
