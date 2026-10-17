// Regression guard for P0 "Sender.onFilesPick registers 0-byte files as
// Resend-able entries":
//
//   const validateErr = validateFileMetadata(fileMetaData);
//   if (validateErr) {
//     addToastMessage(`${file.name} ${validateErr.message}`, 'error');
//   }
//   const id = crypto.randomUUID();
//   sendingFiles[id] = { ..., error: validateErr, status: FileStatus.Pending };
//
// A 0-byte file can never complete a transfer, yet the pre-fix pick path
// registered it as an ordinary Pending entry with `error: validateErr`
// ('invalid file size' from the shared validator). That entry is a
// guaranteed dead-end with an error-toast loop on every retry:
//
//   1. onFilesPick registers it Pending + error = 'invalid file size'.
//      SendingFileList renders a Resend button for any entry that has an
//      error (sendingFile.error && !connectionLost).
//   2. Resend -> onSend(key) resets error = undefined; stop = false; and
//      re-sends the metadata. The channel send succeeds, so the entry bounces
//      to WaitingAccept with no error.
//   3. Receiver onMetaData -> validateFileMetadata(metaData, max) ->
//      size <= 0 -> EVENT_VALIDATE_ERROR sent back. Even if accepted,
//      processChunk's exact-match completion gate (receivedSize === size) can
//      never be satisfied by a 0-byte file.
//   4. Sender's EVENT_VALIDATE_ERROR handler toasts 'Receiver validate error'
//      and bounces the entry back to Pending + error.
//   5. Resend is offered again -> an infinite retry loop that re-fires a new
//      error toast on every click. sendAllFiles() skips entries with f.error,
//      so "Send all files" silently ignores it too.
//
// The receiver-side guard already exists (the validator rejects size <= 0 and
// the receiver bounces the sender with EVENT_VALIDATE_ERROR), so this is a
// purely sender-side registration bug: the entry should never have been
// ressendable in the first place. The fix mirrors the two sibling guards in
// onFilesPick (the `!rsaPub` guard and the crypto try/catch): surface a
// visible toast AND `continue` without registering the entry, so an
// undeliverable file never enters sendingFiles and no Resend/Send affordance
// is ever offered for it.
//
// Node cannot mount the Svelte component, so (mirroring
// tests/sender-onfilespick-crypto-rejection.test.mjs) this test (1) statically
// asserts the skip-on-validation-error shape in Sender.svelte and (2)
// dynamically exercises the REAL shared validateFileMetadata helper to prove
// the 0-byte metadata is rejected — the single source of truth the sender
// and receiver both rely on, so the pair cannot drift apart.
import { strict as assert } from 'node:assert';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');

const senderSource = await readFile(
  join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
  'utf8'
);

// ---- Helper: extract a top-level function body by name (brace matched) ----
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

// ---- Helper: extract the `if (validateErr) { ... }` block (brace matched) ---
function extractValidateErrBlock(body) {
  const start = body.search(/if\s*\(\s*validateErr\s*\)\s*\{/);
  assert.ok(start !== -1, 'the `if (validateErr)` guard block must exist in onFilesPick');
  const braceStart = body.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') {
      depth--;
      if (depth === 0) return { block: body.slice(braceStart, i + 1), end: i + 1 };
    }
  }
  throw new assert.AssertionError({ message: 'if (validateErr): unbalanced braces' });
}

// ---- Test 1 (static): validation error -> toast + continue, no registration
{
  const body = extractFunction(senderSource, 'onFilesPick');

  // The shared validator must be the single source of truth for the pick-time
  // decision (already imported at the top of the component).
  assert.ok(
    /validateFileMetadata\s*\(\s*fileMetaData\s*\)/.test(body),
    'onFilesPick must run the shared validateFileMetadata(fileMetaData) helper'
  );

  const { block, end } = extractValidateErrBlock(body);

  // The guard must surface a visible error toast...
  assert.ok(
    /addToastMessage\s*\([^;]*'error'/.test(block),
    'the validateErr guard must surface a visible error toast'
  );
  // ...and must SKIP the file (continue) instead of falling through to
  // registration — exactly the shape of the sibling !rsaPub and crypto guards.
  assert.ok(
    /continue\s*;/.test(block),
    'the validateErr guard must skip registration (continue), not just toast'
  );
  // And it must NOT register a sending-file entry inside that guard block.
  assert.ok(
    !/sendingFiles\s*\[\s*id\s*\]\s*=/.test(block),
    'the validateErr guard must not register a sendingFiles[id] entry'
  );

  // The registration must happen AFTER the guard's `continue`, so a rejected
  // file never reaches it: the `continue;` inside the guard must precede the
  // `const id = crypto.randomUUID();` + `sendingFiles[id] =` registration.
  const regIndex = body.search(/const\s+id\s*=\s*crypto\.randomUUID\s*\(\s*\)/);
  assert.ok(
    regIndex !== -1,
    'the entry registration (const id = crypto.randomUUID()) must still exist'
  );
  assert.ok(
    end < regIndex,
    'the validateErr guard (which continues) must come before the entry registration'
  );
  // And the registered entry must no longer carry the validator's error —
  // that was the pre-fix dead-end that made the entry Resend-able.
  const regBlock = body.slice(regIndex);
  const assignMatch = regBlock.search(/sendingFiles\s*\[\s*id\s*\]\s*=\s*\{/);
  assert.ok(assignMatch !== -1, 'the sendingFiles[id] = { ... } registration must exist');
  const regObject = regBlock.slice(assignMatch, regBlock.indexOf('};', assignMatch));
  assert.ok(
    !/error\s*:\s*validateErr/.test(regObject),
    'the registered entry must not carry `error: validateErr` (pre-fix shape)'
  );
  console.log(
    'ok - onFilesPick: validation error surfaces a toast and skips registration (continue)'
  );
}

// ---- Test 2 (static): the pre-fix `error: validateErr` shape is gone --------
{
  // The entire `error: validateErr` token was only ever set in the pick-time
  // registration, so it must be gone from the whole component now that a
  // rejected file is skipped instead of registered.
  assert.ok(
    !/error\s*:\s*validateErr/.test(senderSource),
    'Sender.svelte must no longer register an entry with `error: validateErr`'
  );
  console.log('ok - the pre-fix `error: validateErr` registration shape is gone');
}

// ---- Test 3 (dynamic): the REAL validator rejects 0-byte metadata ----------
// The shared validateFileMetadata is what the fix gates on, and it is the
// same predicate the receiver enforces. Transpile and import the REAL
// function (not a copy that can drift), then prove the 0-byte metadata the
// bug is about is rejected — so the sender-side skip and the receiver-side
// EVENT_VALIDATE_ERROR cannot drift apart.
{
  const source = await readFile(join(here, '..', 'src', 'utils', 'validator.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020
    }
  });
  const utilsDir = join(here, '..', 'src', 'utils');
  const fixed = compiled.outputText.replace(/from ['"](\.[^'"]+)['"]/g, (_all, spec) => {
    const withExt = /\.(ts|js|mjs|json)$/.test(spec) ? spec : `${spec}.ts`;
    return `from '${join(utilsDir, withExt).replace(/\\/g, '/')}'`;
  });
  const tmpPath = join(here, `.validator-zero.tmp.js`);
  await writeFile(tmpPath, fixed, 'utf8');
  try {
    const { validateFileMetadata } = await import(tmpPath);

    // The exact 0-byte metadata the bug is about: the task's probe.
    const err = validateFileMetadata({
      name: 'empty.txt',
      size: 0,
      type: '',
      key: new Uint8Array(0)
    });
    assert.ok(err instanceof Error, 'a 0-byte file must be rejected by validateFileMetadata');
    assert.equal(err.message, 'invalid file size');

    // The sender never passes a maxSize argument (local pick), so the rejection
    // must fire on the size guard alone, not the upper bound.
    const errNoMax = validateFileMetadata({
      name: 'empty.txt',
      size: 0,
      type: '',
      key: new Uint8Array(0)
    });
    assert.ok(errNoMax instanceof Error, 'size <= 0 must be rejected with no maxSize argument');

    // A healthy positive-size file must still pass so the fix does not skip
    // deliverable files (no over-broad guard).
    assert.equal(
      validateFileMetadata({
        name: 'ok.bin',
        size: 4096,
        type: 'application/octet-stream',
        key: new Uint8Array(0)
      }),
      undefined,
      'a positive-size file must still be accepted'
    );
    console.log('ok - validateFileMetadata rejects the 0-byte metadata the fix gates on');
  } finally {
    await rm(tmpPath, { force: true });
  }
}

// ---- Test 4 (static): the pre-fix consequence is what we are guarding -----
// Document WHY the registration mattered: an entry carrying the validator's
// error is exactly what SendingFileList renders as Resend-able, and what
// sendAllFiles skips. These two affordances are the loop the fix breaks, so
// pin that their gating conditions still reference the entry's `error` /
// `Pending` state — the loop only exists because such an entry could exist.
{
  const listSource = await readFile(
    join(here, '..', 'src', 'components', 'sender', 'SendingFileList.svelte'),
    'utf8'
  );
  // A Resend button is offered for any entry that has an error on a live
  // channel — the affordance that re-fired the toast on every click.
  assert.ok(
    /sendingFile\.error\s*&&\s*!connectionLost[\s\S]{0,80}onSend/.test(listSource),
    'SendingFileList offers a Resend (onSend) for entries carrying an error'
  );

  const sendAll = extractFunction(senderSource, 'sendAllFiles');
  // "Send all files" silently ignores entries that carry an error — the
  // second half of the dead-end: they can never reach Success while listed.
  assert.ok(/f\.error/.test(sendAll), 'sendAllFiles must skip entries that carry an error');
  console.log(
    'ok - pre-fix consequence documented: an error entry is Resend-able and skipped by Send all'
  );
}

console.log(
  'ok - sender onFilesPick: 0-byte (invalid-size) files are toasted + skipped, never registered Resend-able'
);
