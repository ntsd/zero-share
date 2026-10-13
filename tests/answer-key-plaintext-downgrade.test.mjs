// Regression guard for P1 "encrypted transfer dead-ends when the receiver
// downgraded to plaintext": when the receive page detects a malformed `p`
// (RSA public key) URL param it deliberately downgrades to plaintext and
// answers with a well-formed but EMPTY key portion (`sdp|` with `''` after
// the `|`). The offer side's acceptAnswer used to run
// importRsaPublicKeyFromBase64('') → reject → toast + return, so
// setRemoteDescription was never called and the handshake never completed.
//
// The fix (src/components/OfferPage.svelte) distinguishes the two cases:
//   - `|` present + empty key  -> the receiver's deliberate plaintext
//     downgrade: set effectiveEncrypt=false, toast, PROCEED to
//     setRemoteDescription.
//   - no `|` / non-empty key that fails to import -> genuinely malformed
//     pasted/QR data: keep the "Invalid encryption key in answer code"
//     error toast + bail (unchanged behavior).
// The effective-encryption flag must flow to the Sender/Receiver props so
// they never encrypt/decrypt with an undefined key.
//
// Svelte components cannot run under Node, so this test follows the repo
// convention (tests/sdp-robustness.test.mjs): the REAL parseAnswerCode
// function is extracted from the .svelte source, transpiled with the
// installed typescript package, and exercised; the branch structure of
// acceptAnswer is pinned with static source guards.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const sveltePath = join(here, '..', 'src', 'components', 'OfferPage.svelte');
const source = readFileSync(sveltePath, 'utf8');

// ---- Helper: find the full function text in Svelte source (signature +
// body) so it can be transpiled standalone ----
function extractFunction(src, name) {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.ok(start !== -1, `${name}() must exist in OfferPage.svelte`);
  // Walk from the closing `)` of the parameter list (TS return-type
  // annotations may contain parens, so brace-walk past the param `(`) to
  // find the `{` that actually opens the function body.
  const paramParen = src.indexOf('(', start);
  let depth = 0;
  let paramEnd = -1;
  for (let i = paramParen; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) {
        paramEnd = i;
        break;
      }
    }
  }
  assert.ok(paramEnd !== -1, `${name}(): unbalanced parameter parens`);
  const braceStart = src.indexOf('{', paramEnd);
  assert.ok(braceStart !== -1, `${name}(): no function body found`);
  depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new assert.AssertionError({ message: `${name}(): unbalanced braces` });
}

// ---- Test 1: the REAL parseAnswerCode, extracted and run under Node ----
{
  const fnSource = extractFunction(source, 'parseAnswerCode');
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const compiled = ts.transpileModule(fnSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }
  });
  const compiledPath = join(here, '.answer-key-parse.tmp.js');
  await writeFile(compiledPath, `export ${compiled.outputText}`, 'utf8');
  try {
    const { parseAnswerCode } = await import(compiledPath);

    // The receiver's plaintext downgrade signal: sdp + '|' + '' — well
    // formed, empty key.
    const downgrade = parseAnswerCode('AAAA~BBB-|');
    assert.deepEqual(
      downgrade,
      { sdp: 'AAAA~BBB-', key: '', hasSeparator: true },
      'empty-key downgrade code must parse as sdp + empty key + separator present'
    );

    // Encrypted answer: sdp + '|' + <base64 key>.
    const encrypted = parseAnswerCode('AAAA~BBB-|MIGfMA0GCSqGSIb3');
    assert.equal(encrypted.sdp, 'AAAA~BBB-');
    assert.equal(encrypted.key, 'MIGfMA0GCSqGSIb3');
    assert.equal(encrypted.hasSeparator, true);

    // Split on the LAST `|`: base64url SDP never contains `|`, but a key
    // portion containing one must not be mis-split.
    const tricky = parseAnswerCode('AAAA|BBB|CCC');
    assert.deepEqual(
      tricky,
      { sdp: 'AAAA|BBB', key: 'CCC', hasSeparator: true },
      'must split on the LAST `|`, not the first'
    );

    // Genuinely malformed code: no `|` at all.
    const noSep = parseAnswerCode('AAAA~BBB-');
    assert.deepEqual(noSep, { sdp: 'AAAA~BBB-', key: '', hasSeparator: false });

    console.log(
      'ok - parseAnswerCode: real Svelte function handles downgrade/encrypted/no-separator codes'
    );
  } finally {
    await rm(compiledPath, { force: true });
  }
}

// ---- Test 2: the key decision in acceptAnswer (fixture mirroring the branches) ----
// importRsaPublicKeyFromBase64('') rejects under WebCrypto (atob('') ->
// empty buffer -> importKey 'spki' with no key data). The fixture documents
// that premise with a stub and mirrors the component's branch structure:
// downgrade branch must NOT bail; the import-failure branch MUST bail.
{
  const importKeyStub = async (key) => {
    if (key === '') throw new Error('spki import of empty key data rejects');
    if (!key.startsWith('MIGf')) throw new Error('damaged SPKI DER');
    return { ok: true };
  };

  // Mirrors the acceptAnswer key gate: isEncrypt on, decide what happens to
  // the answer's key portion. Returns { bail, downgrade, rsaPub }.
  const decide = async ({ hasSeparator, key }) => {
    if (hasSeparator && key === '') {
      return { bail: false, downgrade: true, rsaPub: undefined };
    }
    try {
      const rsaPub = await importKeyStub(key);
      return { bail: false, downgrade: false, rsaPub };
    } catch {
      return { bail: true, downgrade: false, rsaPub: undefined };
    }
  };

  // 2a. Deliberate plaintext downgrade -> no bail, proceed.
  const down = await decide({ hasSeparator: true, key: '' });
  assert.deepEqual(down, { bail: false, downgrade: true, rsaPub: undefined });

  // 2b. Valid encrypted key -> import proceeds, no downgrade.
  const enc = await decide({ hasSeparator: true, key: 'MIGfMA0GCSqGSIb3' });
  assert.deepEqual(enc, { bail: false, downgrade: false, rsaPub: { ok: true } });

  // 2c. Non-empty but invalid key -> bail (preserved behavior).
  const bad = await decide({ hasSeparator: true, key: 'AAAA~BBB-' });
  assert.equal(bad.bail, true, 'non-empty invalid key must still bail');
  assert.equal(bad.downgrade, false);

  // 2d. No separator at all -> bail (malformed code, not a downgrade signal).
  const noSep = await decide({ hasSeparator: false, key: '' });
  assert.equal(noSep.bail, true, 'missing `|` must still bail, not downgrade');

  console.log('ok - key decision: empty-key downgrade proceeds; invalid/missing key still bails');
}

// ---- Test 3: static source guards on OfferPage.svelte ----
{
  const acceptBody = extractFunction(source, 'acceptAnswer');

  // 3a. acceptAnswer no longer blind-splits on `|`; it consumes the
  //     parseAnswerCode result.
  assert.ok(
    !/answerSDP\.split\('\|'\)/.test(acceptBody),
    "acceptAnswer must not use the blind answerSDP.split('|')"
  );
  assert.ok(
    /parseAnswerCode\(\s*answerSDP\s*\)/.test(acceptBody),
    'acceptAnswer must consume parseAnswerCode(answerSDP)'
  );

  // 3b. The downgrade branch: empty key + separator sets effectiveEncrypt
  //     to false and does NOT bail — the branch must contain no `return`.
  //     Brace-walk the `if (hasSeparator && key === '')` block.
  const downBranchStart = acceptBody.search(/if\s*\(\s*hasSeparator\s*&&\s*key\s*===\s*''\s*\)/);
  assert.ok(
    downBranchStart !== -1,
    "downgrade branch `if (hasSeparator && key === '')` must exist"
  );
  const downBrace = acceptBody.indexOf('{', downBranchStart);
  let depth = 0;
  let downEnd = -1;
  for (let i = downBrace; i < acceptBody.length; i++) {
    if (acceptBody[i] === '{') depth++;
    else if (acceptBody[i] === '}') {
      depth--;
      if (depth === 0) {
        downEnd = i + 1;
        break;
      }
    }
  }
  assert.ok(downEnd !== -1, 'downgrade branch braces must balance');
  const downBranch = acceptBody.slice(downBrace, downEnd);
  assert.ok(
    /effectiveEncrypt\s*=\s*false/.test(downBranch),
    'downgrade branch must set effectiveEncrypt = false'
  );
  assert.ok(/addToastMessage\s*\(/.test(downBranch), 'downgrade branch must surface a toast');
  assert.ok(
    !/return\s*;/.test(downBranch),
    'downgrade branch must NOT bail — the handshake must proceed'
  );

  // 3c. The invalid-key branch is intact: import wrapped in try/catch with
  //     the original error toast AND a bail (`return;`).
  assert.ok(
    /importRsaPublicKeyFromBase64\(\s*key\s*\)/.test(acceptBody),
    'acceptAnswer must import the (non-empty) key portion'
  );
  const invalidToast =
    /addToastMessage\s*\(\s*['"`]Invalid encryption key in answer code['"`]\s*,\s*['"`]error['"`]/;
  assert.ok(
    invalidToast.test(acceptBody),
    "non-empty invalid key must keep toast 'Invalid encryption key in answer code'"
  );
  // the bail `return;` sits inside a catch that follows the import call
  const catchAfterImport = acceptBody.slice(acceptBody.indexOf('importRsaPublicKeyFromBase64'));
  assert.ok(
    /catch\s*(?:\([^)]*\))?\s*\{[^}]*return\s*;/.test(catchAfterImport),
    "import failure must still bail (return;) — it's pasted-garbage, not a downgrade"
  );

  // 3d. effectiveEncrypt state exists and both sub-components receive it
  //     (not sendOptions.isEncrypt), so no encrypt/decrypt with an undefined
  //     key after the downgrade.
  assert.ok(
    /let\s+effectiveEncrypt\s*=\s*\$state\(\s*sendOptions\.isEncrypt\s*\)/.test(source),
    'effectiveEncrypt $state must start as sendOptions.isEncrypt'
  );
  const senderTag = source.match(/<Sender[\s\S]*?\/>/)?.[0] ?? '';
  assert.ok(
    /isEncrypt=\{effectiveEncrypt\}/.test(senderTag),
    'Sender must receive isEncrypt={effectiveEncrypt}'
  );
  const receiverTag = source.match(/<Receiver[\s\S]*?\/>/)?.[0] ?? '';
  assert.ok(
    /isEncrypt=\{effectiveEncrypt\}/.test(receiverTag),
    'Receiver must receive isEncrypt={effectiveEncrypt}'
  );
  assert.ok(
    !/isEncrypt=\{sendOptions\.isEncrypt\}/.test(source),
    'OfferPage must not pass sendOptions.isEncrypt to Sender/Receiver anymore'
  );

  // 3d2. effectiveEncrypt must stay in sync with the user's setting. A plain
  //      $state initializer is NOT a live binding in Svelte 5: the value would
  //      go stale when the user toggles encryption in Settings after the
  //      downgrade branch (or an encrypted accept) last wrote to it — e.g.
  //      re-enabling encryption after a downgrade would leave Sender with
  //      isEncrypt=false and no AES key. Because this component is in runes
  //      mode (uses $state) a `$:` reactive re-sync is NOT allowed; instead
  //      onOptionsUpdate — the only place sendOptions is mutated — re-syncs
  //      effectiveEncrypt on every options change.
  const onOptionsBody = extractFunction(source, 'onOptionsUpdate');
  assert.ok(
    /effectiveEncrypt\s*=\s*sendOptions\.isEncrypt/.test(onOptionsBody),
    'onOptionsUpdate must re-sync effectiveEncrypt = sendOptions.isEncrypt (a plain $state init is not a live binding)'
  );
  assert.ok(
    /rsaPub\s*=\s*undefined/.test(onOptionsBody),
    'onOptionsUpdate must reset rsaPub so a re-enabled session after a downgrade does not carry the previous peer key'
  );
  // The downgrade branch still overrides the re-synced value to false.
  assert.ok(
    /if\s*\(\s*hasSeparator\s*&&\s*key\s*===\s*''\s*\)[\s\S]*?effectiveEncrypt\s*=\s*false/.test(
      acceptBody
    ),
    'downgrade branch must still override effectiveEncrypt to false'
  );

  // 3e. The SDP guard still runs on every path: the setRemoteDescription
  //     try/catch with the 'Invalid answer code' toast survives.
  assert.ok(
    /try\s*\{[\s\S]*?setRemoteDescription\s*\([\s\S]*?\}\s*catch\s*\{[\s\S]*?addToastMessage\s*\(\s*['"`]Invalid answer code['"`]/.test(
      acceptBody
    ),
    "acceptAnswer must still guard sdpDecode + setRemoteDescription with the 'Invalid answer code' toast"
  );

  console.log(
    'ok - OfferPage.svelte source guards: downgrade proceeds, invalid bails, flag propagates'
  );
}

console.log(
  'ok - answer-key plaintext downgrade: empty-key answer no longer dead-ends the encrypted handshake'
);
