// Regression guard for P1 "RTCPeerConnection iceCandidatePoolSize config is
// inert and inconsistent between sender and receiver peers".
//
// OfferPage constructed its peer with `iceCandidatePoolSize: 4` while
// ReceivePage constructed its peer with only `iceServers` — the two sides of
// the same data-channel session were configured asymmetrically, and the
// sender's value carried the hand-wave comment `// somehow this doesn't work`.
//
// Root cause: `iceCandidatePoolSize` pre-gathers candidates for that many ICE
// components AHEAD of the first gathering phase, and the pool is consumed on
// the first offer/answer exchange only (JSEP §3.5.4 / RFC 9429 §3.5.4). This
// app has exactly one ICE component (a single bundled data channel) and calls
// setLocalDescription within milliseconds of the constructor, so the pool can
// never finish pre-gathering before gathering starts: the value `4` (4x the
// components needed, no idle time to pre-gather) was inert — it was never a
// browser bug. A non-zero size would only pin STUN/TURN allocations for the
// page's lifetime with no connection-time benefit.
//
// The fix: both peers now run on the spec default pool size (0) — the knob is
// absent from BOTH RTCConfiguration object literals and an accurate rationale
// comment documents the decision directly above each construction site.
// `bundlePolicy: 'balanced'` (the spec default, pinned for documentation on
// the sender) is now mirrored on the receiver so the two configuration
// objects stay key-symmetric.
//
// This guard (static source check, the repo's pattern for browser-only
// WebRTC wiring — RTCPeerConnection cannot be exercised under Node) verifies:
//   1. no `iceCandidatePoolSize` KEY remains in either peer's
//      RTCConfiguration object literal — a non-zero pool would be
//      re-introduced on one side and become asymmetric again;
//   2. the two construction sites stay symmetric on their configuration keys:
//      both omit the pool-size knob, both pin bundlePolicy, and neither side
//      ever grows a new configuration key without the other;
//   3. the misleading `// somehow this doesn't work` hand-wave is gone, and
//      each construction site instead carries the accurate rationale (spec
//      default 0, single ICE component, immediate setLocalDescription, no
//      pre-gather window, allocation cost);
//   4. both sites still configure `iceServers` from the validated `iceServer`
//      variable (the shared-resolver behavior pinned by
//      tests/ice-server-consistency.test.mjs).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const offerSource = readFileSync(join(here, '..', 'src', 'components', 'OfferPage.svelte'), 'utf8');
const receiveSource = readFileSync(
  join(here, '..', 'src', 'components', 'ReceivePage.svelte'),
  'utf8'
);

// ---- Helper: extract the RTCPeerConnectionConfiguration object literal ----
// Both pages construct exactly one peer: `new RTCPeerConnection({...})`. Walk
// from the `new RTCPeerConnection(` call to its matching `)`, taking the
// balanced inner `{...}` as the configuration object. The call start index is
// also returned so callers can inspect the rationale comment directly above
// the construction site.
function extractPeerConfig(source, label) {
  const callIdx = source.indexOf('new RTCPeerConnection(');
  assert.ok(
    callIdx !== -1,
    `${label}: the peer must still be constructed with new RTCPeerConnection(`
  );
  let i = source.indexOf('{', callIdx);
  assert.ok(i !== -1, `${label}: the constructor must take an object literal configuration`);
  let depth = 0;
  let end = -1;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  assert.ok(
    end !== -1,
    `${label}: unbalanced braces in the RTCPeerConnection configuration object`
  );
  return { config: source.slice(i, end + 1), callIdx, configEnd: end };
}

// Top-level object keys of the configuration literal (keys are bare
// identifiers in a plain object literal, so a per-line scan suffices).
function configKeys(config) {
  const keys = new Set();
  for (const line of config.split('\n')) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

const {
  config: offerConfig,
  callIdx: offerCallIdx,
  configEnd: offerConfigEnd
} = extractPeerConfig(offerSource, 'OfferPage');
const {
  config: receiveConfig,
  callIdx: receiveCallIdx,
  configEnd: receiveConfigEnd
} = extractPeerConfig(receiveSource, 'ReceivePage');
const offerKeys = configKeys(offerConfig);
const receiveKeys = configKeys(receiveConfig);

// ---- 1: the inert knob must not be re-introduced on EITHER side ----
{
  for (const [label, config] of [
    ['OfferPage', offerConfig],
    ['ReceivePage', receiveConfig]
  ]) {
    assert.ok(
      !config.includes('iceCandidatePoolSize'),
      `${label}: the RTCPeerConnectionConfiguration object must not set iceCandidatePoolSize ` +
        `(the pool is inert here — single ICE component, setLocalDescription immediately after ` +
        `construction — and any non-zero size would be asymmetric vs the peer; keep the spec default 0)`
    );
  }
  // No pool-size reconfiguration outside the constructor objects either:
  // setConfiguration() would be the only other way to change it.
  assert.ok(
    !/\.setConfiguration\s*\(/.test(offerSource + receiveSource),
    'neither page must call setConfiguration() — the peer is constructed once with its final configuration'
  );
  console.log(
    'ok - neither peer sets iceCandidatePoolSize (spec default 0 stays in force on both sides)'
  );
}

// ---- 2: the two configuration objects stay symmetric on their keys ----
{
  const symDiff = [
    [...offerKeys].filter((k) => !receiveKeys.has(k)),
    [...receiveKeys].filter((k) => !offerKeys.has(k))
  ]
    .flat()
    .sort();
  assert.equal(
    symDiff.length,
    0,
    `the two RTCPeerConnectionConfiguration objects must stay symmetric on their keys; ` +
      `diverging key: ${JSON.stringify(symDiff)} — a new configuration key added on only one side ` +
      `re-introduces the sender/receiver asymmetry this task fixes (mirror it on the other peer)`
  );
  assert.ok(
    offerKeys.has('iceServers') && receiveKeys.has('iceServers'),
    'both peers must configure iceServers'
  );
  assert.ok(
    offerKeys.has('bundlePolicy') && receiveKeys.has('bundlePolicy'),
    'both peers must pin bundlePolicy (spec default "balanced", mirrored for symmetry)'
  );
  console.log(
    `ok - configuration keys symmetric across both peers: ${[...offerKeys].sort().join(', ')}`
  );
}

// ---- 3: the hand-wave is replaced by the accurate rationale, at BOTH sites ----
{
  // The rationale lives directly above each construction site (between the
  // previous statement and the `new RTCPeerConnection(` call). Window: the
  // 2000 characters before the call plus the config object itself.
  for (const [label, source, callIdx, configEnd] of [
    ['OfferPage', offerSource, offerCallIdx, offerConfigEnd],
    ['ReceivePage', receiveSource, receiveCallIdx, receiveConfigEnd]
  ]) {
    assert.ok(
      !/somehow this doesn't work/.test(source),
      `${label}: the "// somehow this doesn't work" hand-wave must not come back — replace it with the rationale comment`
    );
    const site = source.slice(Math.max(0, callIdx - 2000), configEnd + 1);
    assert.ok(
      /iceCandidatePoolSize/.test(site),
      `${label}: the construction site must document the iceCandidatePoolSize decision`
    );
    assert.ok(
      /spec default \(0\)/.test(site),
      `${label}: the rationale must state that iceCandidatePoolSize is left at the spec default (0)`
    );
    assert.ok(
      /pre-?gather/.test(site),
      `${label}: the rationale must explain that the pool pre-gathers candidates ahead of the first gathering phase`
    );
    assert.ok(
      /\b(one|single|exactly one) ICE component/i.test(site),
      `${label}: the rationale must state the app has a single ICE component`
    );
    assert.ok(
      /setLocalDescription/.test(site),
      `${label}: the rationale must explain that setLocalDescription runs immediately after the constructor, so the pool has no pre-gather window`
    );
    assert.ok(
      /allocat/.test(site),
      `${label}: the rationale must note that a non-zero pool only holds STUN/TURN allocations without connection-time benefit`
    );
  }
  console.log(
    'ok - both peers carry the accurate iceCandidatePoolSize rationale (hand-wave removed)'
  );
}

// ---- 4: untouched behavior still pinned ----
{
  // bundlePolicy: 'balanced' is the spec default, pinned for documentation on
  // BOTH sides (the guard above forbids it diverging).
  assert.ok(
    /bundlePolicy\s*:\s*'balanced'/.test(offerConfig),
    'OfferPage must pin bundlePolicy: "balanced"'
  );
  assert.ok(
    /bundlePolicy\s*:\s*'balanced'/.test(receiveConfig),
    'ReceivePage must pin the same bundlePolicy: "balanced" as the sender'
  );
  // Both sites must keep configuring iceServers from the validated
  // `iceServer` variable (shared-resolver behavior — see
  // tests/ice-server-consistency.test.mjs for the round-trip checks).
  assert.ok(
    /iceServers\s*:\s*\[\s*\{\s*urls\s*:\s*iceServer\s*\}\s*\]/.test(offerConfig),
    'OfferPage must configure iceServers from the shared-resolved iceServer variable'
  );
  assert.ok(
    /iceServers\s*:\s*\[\s*\{\s*urls\s*:\s*iceServer\s*\}\s*\]/.test(receiveConfig),
    'ReceivePage must configure iceServers from the validated iceServer variable'
  );
  console.log('ok - bundlePolicy pin and iceServers wiring preserved at both sites');
}

console.log(
  'ok - RTCPeerConnection configuration symmetric across sender/receiver; inert iceCandidatePoolSize removed with rationale'
);
