// Regression guard for P0 "document-level paste listener hijacks every paste
// on the page — pasting an answer code or custom ICE server into any text
// field silently adds a stray clipboard.txt to the sender file list".
//
// DragAndDrop.svelte registers a document-level `paste` listener
// (document.addEventListener('paste', handlePasteEvent)) so the user can
// ctrl+v an image/text onto the empty page to share it as a file. But the
// ClipboardEvent bubbles to `document`, so ANY paste anywhere on the page —
// into the Answer Code input, the custom ICE server input, any text field —
// also created a File named `clipboard.txt` (or `image.<ext>`) and passed it
// to onFilesPick, silently growing the sender file list and being included
// in `Send all files`.
//
// The fix:
//   1. handlePasteEvent bails out when the paste target is a text-editing
//      element (INPUT / TEXTAREA / SELECT / contentEditable) — a text-field
//      paste belongs to the input, not to file sharing.
//   2. The document listener is removed on destroy (onDestroy), so a re-mount
//      (e.g. reconnect flow re-creating the component tree) cannot stack
//      duplicate handlers.
//
// This test is static: Node cannot mount Svelte DOM components, so it reads
// src/components/sender/DragAndDrop.svelte and asserts the guards exist in
// the source, mirroring sdp-robustness.test.mjs and
// ice-server-consistency.test.mjs.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, '..', 'src', 'components', 'sender', 'DragAndDrop.svelte'),
  'utf8'
);

// ---- Helper: find the body of a named function in the Svelte source ----
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

// ---- Test 1: handlePasteEvent skips pastes into text-editing elements ----
{
  const body = extractFunction(source, 'handlePasteEvent');

  // A target check must exist that inspects the event target's element kind.
  assert.ok(
    /event\.target/.test(body),
    'handlePasteEvent must inspect event.target to find the paste target element'
  );
  assert.ok(
    /INPUT/.test(body) && /TEXTAREA/.test(body) && /isContentEditable/.test(body),
    'handlePasteEvent must skip INPUT / TEXTAREA / contentEditable paste targets'
  );
  assert.ok(/SELECT/.test(body), 'handlePasteEvent must skip SELECT paste targets');

  // The guard must actually bail out — a plain `return;` statement that
  // precedes any clipboard handling — and it must come BEFORE the file-creation
  // helpers are called, otherwise a stray clipboard.txt / image.<ext> is still
  // added when pasting into a text field.
  const guardIndex = body.search(/\breturn\s*;/);
  assert.ok(
    guardIndex !== -1,
    'handlePasteEvent must early-return when the target is a text field'
  );

  const textHelperIndex = body.search(/handleTextClipboard\s*\(/);
  const fileHelperIndex = body.search(/handleFileClipboard\s*\(/);
  assert.ok(
    textHelperIndex !== -1,
    'handlePasteEvent must still route pasted text to handleTextClipboard'
  );
  assert.ok(
    fileHelperIndex !== -1,
    'handlePasteEvent must still route pasted files to handleFileClipboard'
  );
  assert.ok(
    guardIndex < textHelperIndex && guardIndex < fileHelperIndex,
    'the text-field guard must run before any clipboard file creation'
  );
  console.log('ok - handlePasteEvent skips pastes into text fields (no stray clipboard.txt)');
}

// ---- Test 2: the document-level paste listener is removed on unmount ----
{
  // The document listener must still exist (the feature: paste on empty page
  // areas adds the file) …
  assert.ok(
    /document\.addEventListener\s*\(\s*['"]paste['"]\s*,\s*handlePasteEvent\s*\)/.test(source),
    'the document-level paste listener must still be registered (feature preserved)'
  );

  // … and a matching removal must exist in the same file, wired to Svelte's
  // onDestroy so a re-mounted DragAndDrop cannot stack duplicate handlers.
  assert.ok(
    /document\.removeEventListener\s*\(\s*['"]paste['"]\s*,\s*handlePasteEvent\s*\)/.test(source),
    'the document-level paste listener must be removed (removeEventListener)'
  );
  assert.ok(
    /onDestroy\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?removeEventListener[\s\S]*?\}\s*\)/.test(source),
    'the removal must run in onDestroy so re-mounts cannot stack handlers'
  );
  assert.ok(
    /onDestroy/.test(source) && /onMount/.test(source),
    'onDestroy must be imported alongside onMount'
  );
  console.log(
    'ok - document paste listener is removed on destroy (no stacked handlers on re-mount)'
  );
}

console.log('ok - DragAndDrop paste: text-field pastes never add files, listener cleaned up');
