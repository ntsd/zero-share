// Regression guard for P0 "malformed SDP input crashes the page via uncaught
// sdpDecode throw": sdpDecode (src/utils/sdpEncode.ts) throws synchronously on
// malformed input, but its two call sites invoked it without any try/catch:
//   1. ReceivePage.svelte setOfferSDP() — the `s` URL param of the shared offer
//      link is attacker-controllable; a crafted/truncated value crashed the
//      entire page during Astro load.
//
// This test verifies:
//   1. The real sdpEncode/sdpDecode (transpiled from src/utils/sdpEncode.ts)
//      round-trip a valid SDP byte-exactly through the URL-safe codec, and
//      sdpDecode throws synchronously on malformed input.
//   2. sdpDecode is a TRUE inverse for SDP carrying ICE candidate lines: the
//      uppercase `UDP` transport token must survive the round-trip (the prior
//      sdp-compact dictionary codec corrupted it to `udpDP` — its encode map
//      keyed lowercase `udp` while the decode map still rewrote the `U` inside
//      an uncompressed `UDP` token, so both peers silently dropped each
//      other's candidates and connectivity broke).
//   3. sdpEncode output is RFC3986 unreserved-only (`[A-Za-z0-9-._~]`), since
//      it embeds in the `s`/`c`/`p` URL params and the answer code.
//   4. ReceivePage.svelte wraps the sdpDecode + setRemoteDescription call in a
//      try/catch that surfaces addToastMessage('Invalid SDP in link', 'error').
//   5. OfferPage.svelte wraps the sdpDecode + setRemoteDescription call in a
//      try/catch that surfaces addToastMessage('Invalid answer code', 'error').
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));

// Transpile the REAL src/utils/sdpEncode.ts to a plain ESM temp file next to
// the test and import it (same pattern as tests/message-decode-robustness.
// test.mjs). The codec is dependency-free (standard base64url over
// btoa/atob), so no resolve hooks or package shims are needed under Node.
const require = createRequire(import.meta.url);
const ts = require('typescript');

const compiledPath = join(here, '.sdp-robustness.tmp.js');
const tsSource = await readFile(join(here, '..', 'src', 'utils', 'sdpEncode.ts'), 'utf8');
const compiled = ts.transpileModule(tsSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020
  }
});
await writeFile(compiledPath, compiled.outputText, 'utf8');
try {
  const { sdpEncode, sdpDecode } = await import(compiledPath);

  // ---- Test 1: valid SDP round-trips; malformed inputs throw ----
  {
    const sdp =
      'v=0\r\n' +
      'o=- 4611731719708415146 3 IN IP4 0.0.0.0\r\n' +
      's=-\r\n' +
      't=0 0\r\n' +
      'm=application 9 IN IP4 0.0.0.0\r\n' +
      'c=IN IP4 0.0.0.0\r\n';

    const encoded = sdpEncode(sdp);
    const decoded = sdpDecode(encoded);
    assert.equal(decoded, sdp, 'valid SDP must round-trip byte-exactly (true inverse codec)');

    const malformed = ['', 'x', 'aaaa', Buffer.from('not sdp').toString('base64')];
    let threw = 0;
    for (const bad of malformed) {
      try {
        sdpDecode(bad);
        throw new assert.AssertionError({
          message: `expected sdpDecode to throw for ${JSON.stringify(bad)}`
        });
      } catch (e) {
        if (e instanceof assert.AssertionError) throw e;
        threw++;
      }
    }
    assert.equal(threw, malformed.length, 'all malformed inputs must make sdpDecode throw');
    console.log(
      'ok - sdpEncode/sdpDecode (real module): valid SDP round-trips, malformed inputs throw'
    );
  }

  // ---- Test 2: ICE-candidate SDP round-trips without protocol-token corruption ----
  {
    // A realistic data-channel SDP the way a browser emits it at link time:
    // trickle-complete `localDescription` with uppercase UDP/TCP candidate
    // transport tokens. The legacy sdp-compact codec decoded the UDP token to
    // `udpDP` here; this guard fails on that regression.
    const candidateSdp =
      'v=0\r\n' +
      'o=- 4611731719708415146 3 IN IP4 0.0.0.0\r\n' +
      's=-\r\n' +
      't=0 0\r\n' +
      'a=group:BUNDLE 0\r\n' +
      'm=application 9 UDP/DTLS/SCTP 443 IN IP4 0.0.0.0\r\n' +
      'c=IN IP4 0.0.0.0\r\n' +
      'a=mid:0\r\n' +
      'a=setup:actpass\r\n' +
      'a=ice-options:trickle\r\n' +
      'a=fingerprint:sha-256 AB:CD:EF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE\r\n' +
      'a=candidate:123 1 UDP 2130706431 192.168.1.5 54321 typ host\r\n' +
      'a=candidate:456 1 TCP 2130706431 192.168.1.5 54322 typ host tcptype active\r\n';

    const encoded = sdpEncode(candidateSdp);
    const decoded = sdpDecode(encoded);
    assert.equal(
      decoded,
      candidateSdp,
      'candidate-bearing SDP must round-trip byte-exactly; got: ' + JSON.stringify(decoded)
    );

    const udpLine = decoded.split(/\r\n/).find((l) => l.startsWith('a=candidate:123'));
    assert.ok(udpLine, 'UDP candidate line must survive the round-trip');
    assert.ok(
      udpLine.includes(' UDP ') && !udpLine.includes('udpDP'),
      `UDP transport token must stay uppercase: ${JSON.stringify(udpLine)}`
    );

    const tcpLine = decoded.split(/\r\n/).find((l) => l.startsWith('a=candidate:456'));
    assert.ok(
      tcpLine && tcpLine.includes(' TCP '),
      `TCP transport token must survive: ${JSON.stringify(tcpLine)}`
    );

    const mediaLine = decoded.split(/\r\n/).find((l) => l.startsWith('m='));
    assert.ok(
      mediaLine && mediaLine.includes('UDP/DTLS/SCTP'),
      `media protocol token must survive: ${JSON.stringify(mediaLine)}`
    );

    // The encoded payload embeds in URL query params (`s`, `c`, `p`): it must
    // be RFC3986 unreserved-only so no consumer needs percent-encoding.
    assert.match(
      encoded,
      /^[A-Za-z0-9-._~]+$/,
      'sdpEncode output must contain only URL-safe [A-Za-z0-9-._~] characters'
    );
    console.log(
      'ok - sdpEncode/sdpDecode: ICE-candidate SDP round-trips without protocol-token corruption'
    );
  }
} finally {
  await rm(compiledPath, { force: true });
}

// ---- Helper: find the body of a named async function in Svelte source ----
function extractFunction(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.ok(start !== -1, `${name}() must exist`);
  // Walk from the first `{` after the signature, balancing braces to find the
  // end of the function body.
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

// Assert the function body contains a try { ... } catch { ... } block whose
// try portion contains both a sdpDecode call and a setRemoteDescription call,
// and whose catch portion adds the given error toast. `acceptAnswer` also has
// an earlier try/catch for the RSA key import — the backtracking regex finds
// the LAST matching guard, which is the one covering the decode.
function assertGuardedDecode(funcBody, toastMessage, context) {
  const toastRe = new RegExp(
    `addToastMessage\\s*\\(\\s*['"\`]${toastMessage}['"\`]\\s*,\\s*['"\`]error['"\`]`
  );
  const tryRe = /try\s*\{([\s\S]*?)\}\s*catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}/g;
  let m;
  let found = null;
  while ((m = tryRe.exec(funcBody)) !== null) {
    const [tryBody, catchBody] = [m[1], m[2]];
    if (/sdpDecode\s*\(/.test(tryBody) && /setRemoteDescription\s*\(/.test(tryBody)) {
      found = { tryBody, catchBody };
    }
  }
  assert.ok(found, `${context}: a try/catch must wrap the sdpDecode + setRemoteDescription call`);
  assert.ok(
    toastRe.test(found.catchBody),
    `${context}: catch must call addToastMessage('${toastMessage}', 'error')`
  );
}

// ---- Test 2: ReceivePage.svelte guards the attacker-controllable `s` param ----
{
  const source = readFileSync(join(here, '..', 'src', 'components', 'ReceivePage.svelte'), 'utf8');
  const body = extractFunction(source, 'setOfferSDP');
  assertGuardedDecode(body, 'Invalid SDP in link', 'ReceivePage.svelte setOfferSDP');
  console.log('ok - ReceivePage.svelte: setOfferSDP guards sdpDecode with try/catch + toast');
}

// ---- Test 3: OfferPage.svelte guards the user-pasted / QR-scanned answer code ----
{
  const source = readFileSync(join(here, '..', 'src', 'components', 'OfferPage.svelte'), 'utf8');
  const body = extractFunction(source, 'acceptAnswer');
  assertGuardedDecode(body, 'Invalid answer code', 'OfferPage.svelte acceptAnswer');
  console.log('ok - OfferPage.svelte: acceptAnswer guards sdpDecode with try/catch + toast');
}

console.log('ok - SDP decode robustness: malformed input cannot crash either page');
