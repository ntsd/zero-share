// Regression guard for P0 "malformed SDP input crashes the page via uncaught
// sdpDecode throw": sdpDecode (src/utils/sdpEncode.ts) throws synchronously on
// malformed input, but its two call sites invoked it without any try/catch:
//   1. ReceivePage.svelte setOfferSDP() — the `s` URL param of the shared offer
//      link is attacker-controllable; a crafted/truncated value crashed the
//      entire page during Astro load.
//   2. OfferPage.svelte acceptAnswer() — the answer code is user-pasted or
//      QR-scanned with no validation; a malformed value produced an unhandled
//      rejection with no toast.
//
// This test verifies:
//   1. The real sdpEncode/sdpDecode (transpiled from src/utils/sdpEncode.ts)
//      round-trip a valid SDP through compactSDP + the URL-safe substitution,
//      and sdpDecode throws synchronously on malformed input.
//   2. ReceivePage.svelte wraps the sdpDecode + setRemoteDescription call in a
//      try/catch that surfaces addToastMessage('Invalid SDP in link', 'error').
//   3. OfferPage.svelte wraps the sdpDecode + setRemoteDescription call in a
//      try/catch that surfaces addToastMessage('Invalid answer code', 'error').
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire, register } from 'node:module';

// sdp-compact@0.0.8 ships ESM dist files with extensionless relative imports
// and no "exports" map, so Node's ESM loader cannot resolve its internal
// imports. Register a resolve hook (data-URL thread, Node >= 20.6) that
// retries with a `.js` suffix — the browser (Vite) resolves them fine; only
// Node needs the shim. `register` emits a deprecation notice on newer Node
// (registerHooks exists but has breaking return-shape semantics there), so
// the npm test invocation runs this file with --no-warnings.

register(
  'data:text/javascript,' +
    encodeURIComponent(
      'export async function resolve(s, ctx, next) {' +
        ' try { return await next(s, ctx); }' +
        ' catch (e) {' +
        "   if ((s.startsWith('./') || s.startsWith('../')) && !s.endsWith('.js'))" +
        "     try { return await next(s + '.js', ctx); } catch {}" +
        '   throw e;' +
        ' } }'
    ),
  import.meta.url
);

const here = dirname(fileURLToPath(import.meta.url));

// Transpile the REAL src/utils/sdpEncode.ts to a plain ESM temp file next to
// the test and import it (same pattern as tests/message-decode-robustness.
// test.mjs). Written next to the test file so Node resolves `sdp-compact`
// from node_modules; the resolve hook above keeps sdp-compact's own
// extensionless internal imports loadable.
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
    // A minimal SDP that the library accepts. Note: decompactSDP normalizes
    // through sdp-transform (re-randomizing the o= session id, adding default
    // attributes), so only assert the decoded output is a valid SDP session
    // description — not byte equality.
    const sdp =
      'v=0\r\n' +
      'o=- 4611731719708415146 3 IN IP4 0.0.0.0\r\n' +
      's=-\r\n' +
      't=0 0\r\n' +
      'm=application 9 IN IP4 0.0.0.0\r\n' +
      'c=IN IP4 0.0.0.0\r\n';

    const encoded = sdpEncode(sdp);
    const decoded = sdpDecode(encoded, true);
    assert.ok(
      decoded.startsWith('v=0') && decoded.includes('m=application'),
      `valid SDP must decode to a session description, got: ${JSON.stringify(decoded.slice(0, 80))}`
    );

    const malformed = ['', 'x', 'aaaa', Buffer.from('not sdp').toString('base64')];
    let threw = 0;
    for (const bad of malformed) {
      try {
        sdpDecode(bad, true);
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
