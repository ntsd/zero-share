// Regression guard for P0 "toggling encryption off after generating the
// offer link desyncs E2E mode" AND P1 "encrypted transfer dead-ends when the
// receiver downgraded to plaintext": the receiver ALWAYS answers
// `sdp|<public key>` — empty key when plaintext, base64 SPKI key when
// encrypted. The answer's key portion is therefore the source of truth for
// the session's encryption mode, NOT the sender's live
// `sendOptions.isEncrypt` (which stays mutable in the Settings panel after
// the link's `p` key already pinned the mode):
//   - `|` present + empty key  -> plaintext (deliberate downgrade by a
//     malformed-`p` receiver, or a plaintext link from the start):
//     effectiveEncrypt=false, toast when the setting was encrypted, PROCEED
//     to setRemoteDescription.
//   - non-empty key            -> encrypted: import the key (bad key keeps
//     the "Invalid encryption key in answer code" toast + bail) and pin
//     effectiveEncrypt=true even if the live setting moved behind the link.
//   - no `|` at all            -> genuinely malformed code: visible error
//     toast + bail (this is how the no-separator case stays visible instead
//     of dead-ending the handshake).
// While no offer link exists, onOptionsUpdate re-syncs effectiveEncrypt from
// the setting; once the link is live it must NOT, so Sender/Receiver can't
// desync from the settled mode — and OfferOptions disables the encryption
// select so the desync is impossible to trigger in the UI.
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
// the decision is driven by the answer's key portion, not by the live
// setting — downgrade branch must NOT bail; the import-failure and
// no-separator branches MUST bail.
{
  const importKeyStub = async (key) => {
    if (key === '') throw new Error('spki import of empty key data rejects');
    if (!key.startsWith('MIGf')) throw new Error('damaged SPKI DER');
    return { ok: true };
  };

  // Mirrors the acceptAnswer key decision: given ONLY the parsed answer
  // code (no live setting in sight), decide what happens to the session.
  // Returns { bail, effectiveEncrypt, rsaPub }.
  const decide = async ({ hasSeparator, key }) => {
    if (hasSeparator && key === '') {
      return { bail: false, effectiveEncrypt: false, rsaPub: undefined };
    }
    if (key !== '') {
      try {
        const rsaPub = await importKeyStub(key);
        return { bail: false, effectiveEncrypt: true, rsaPub };
      } catch {
        return { bail: true, effectiveEncrypt: undefined, rsaPub: undefined };
      }
    }
    return { bail: true, effectiveEncrypt: undefined, rsaPub: undefined };
  };

  // 2a. Deliberate plaintext downgrade -> no bail, session pinned to
  //     plaintext.
  const down = await decide({ hasSeparator: true, key: '' });
  assert.deepEqual(down, { bail: false, effectiveEncrypt: false, rsaPub: undefined });

  // 2b. Valid encrypted key -> import proceeds, session pinned to encrypted
  //     even though the caller's live setting is irrelevant here.
  const enc = await decide({ hasSeparator: true, key: 'MIGfMA0GCSqGSIb3' });
  assert.deepEqual(enc, { bail: false, effectiveEncrypt: true, rsaPub: { ok: true } });

  // 2c. Non-empty but invalid key -> bail (preserved behavior).
  const bad = await decide({ hasSeparator: true, key: 'AAAA~BBB-' });
  assert.equal(bad.bail, true, 'non-empty invalid key must still bail');
  assert.equal(bad.rsaPub, undefined);

  // 2d. No separator at all -> bail with a visible error, never a silent
  //     plaintext downgrade and never a dead-end.
  const noSep = await decide({ hasSeparator: false, key: '' });
  assert.equal(noSep.bail, true, 'missing `|` must bail, not downgrade');
  assert.equal(noSep.rsaPub, undefined);

  console.log(
    'ok - key decision: empty-key downgrade proceeds; invalid/missing key still bails; mode follows the answer'
  );
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

  // 3d2. The re-sync from the user's setting is LINK-GATED: while no offer
  //      link exists the setting IS the session mode, so onOptionsUpdate must
  //      keep effectiveEncrypt in sync (a plain $state initializer is not a
  //      live binding in Svelte 5). Once the link is live the session is
  //      pinned by the link's `p` key (and later by the answer's key
  //      portion), so an unguarded `effectiveEncrypt = sendOptions.isEncrypt`
  //      here would desync Sender/Receiver from the peer's settled mode —
  //      the P0 silent-corruption path.
  const onOptionsBody = extractFunction(source, 'onOptionsUpdate');
  assert.ok(
    /if\s*\(\s*!offerLink\s*\)\s*\{[\s\S]*?effectiveEncrypt\s*=\s*sendOptions\.isEncrypt[\s\S]*?\}/.test(
      onOptionsBody
    ),
    'onOptionsUpdate must re-sync effectiveEncrypt = sendOptions.isEncrypt ONLY while no offer link exists (link-gated: a post-generation toggle must not desync the session)'
  );
  assert.ok(
    /rsaPub\s*=\s*undefined/.test(onOptionsBody),
    'onOptionsUpdate must reset rsaPub so a re-enabled session after a downgrade does not carry the previous peer key'
  );
  // The downgrade branch still overrides the pinned value to false.
  assert.ok(
    /if\s*\(\s*hasSeparator\s*&&\s*key\s*===\s*''\s*\)[\s\S]*?effectiveEncrypt\s*=\s*false/.test(
      acceptBody
    ),
    'downgrade branch must still override effectiveEncrypt to false'
  );

  // 3d3. acceptAnswer must NOT gate the key decision on the live setting:
  //      the top-level `if (sendOptions.isEncrypt)` gate is exactly the bug
  //      (with the setting off, the import was skipped and the sender went
  //      plaintext while the peer kept encrypting).
  assert.ok(
    !/if\s*\(\s*sendOptions\.isEncrypt\s*\)/.test(acceptBody),
    'acceptAnswer must not branch on sendOptions.isEncrypt at all — the answer content is the source of truth'
  );
  // The encrypted branch pins the session to encrypted mode: after the
  // import succeeds, effectiveEncrypt must be set to true.
  assert.ok(
    /importRsaPublicKeyFromBase64\s*\(\s*key\s*\)[\s\S]*?effectiveEncrypt\s*=\s*true/.test(
      acceptBody
    ),
    'a successfully imported answer key must pin effectiveEncrypt = true'
  );
  // The no-separator path is a VISIBLE error, not a silent dead-end and not
  // a silent plaintext downgrade (zf-zs-bd8bbd81 must not regress).
  assert.ok(
    /else\s*\{[\s\S]*?addToastMessage\s*\(\s*['"`]Invalid encryption key in answer code['"`]\s*,\s*['"`]error['"`][\s\S]*?return\s*;/.test(
      acceptBody
    ),
    'a missing `|` (no-separator) code must surface a visible error and bail, not dead-end'
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

// ---- Test 4: OfferOptions locks the encryption select once the link is live ----
// The desync must be impossible to trigger in the UI, not just defended in
// onOptionsUpdate: OfferPage passes encryptionLocked={offerLink !== ''} and
// OfferOptions disables the select on that flag.
{
  const optionsSource = readFileSync(
    join(here, '..', 'src', 'components', 'OfferOptions.svelte'),
    'utf8'
  );
  assert.ok(
    /encryptionLocked\?:\s*boolean/.test(optionsSource),
    'OfferOptions must accept an optional encryptionLocked prop'
  );
  assert.ok(
    /disabled=\{encryptionLocked\}/.test(optionsSource),
    'OfferOptions must disable the Encryption select when encryptionLocked'
  );
  const offerOptionsTag = source.match(/<OfferOptions[\s\S]*?\/>/)?.[0] ?? '';
  assert.ok(
    /encryptionLocked=\{offerLink\s*!==\s*''\}/.test(offerOptionsTag),
    "OfferPage must pass encryptionLocked={offerLink !== ''} so the select locks exactly when the link is live"
  );

  console.log('ok - OfferOptions encryption select locks while the offer link is live');
}

console.log(
  'ok - answer-key plaintext downgrade: empty-key answer no longer dead-ends the encrypted handshake'
);
