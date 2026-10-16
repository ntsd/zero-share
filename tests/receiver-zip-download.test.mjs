// Regression guard for P1 "\"Download all files (zip)\" escapes
// createZipStoreOnly rejections as an unhandled rejection".
//
//   - createZipStoreOnly (src/utils/zip.ts, added in #81) throws when an entry
//     is >= 0xffffffff bytes (4 GiB) or when the aggregate archive exceeds the
//     classic-ZIP 32-bit offset/size limit.
//   - downloadAllFiles() in Receiver.svelte is wired straight to
//     onclick={downloadAllFiles} — an async handler with no .catch. Before the
//     guard, a throwing zip assembly rejected unhandled: no toast, no error
//     state, the button silently did nothing.
//   - The receiver's Max Size dropdown offers up to 10 GB / 1 TiB ("Unlimit"),
//     so a 4–10 GiB file can pass validateFileMetadata, transfer to Success,
//     and then hit this dead-end at click time — while the per-file
//     "Download" button (which bypasses the zip writer) keeps working, hiding
//     the reason the bulk download failed.
//
// The fix: downloadAllFiles() wraps the zip assembly in try/catch and
// surfaces the failure via addToastMessage(<message>, 'error') instead of
// letting the rejection escape; the success path (triggerDownload of the
// 'zero-share-files.zip' blob) is unchanged.
//
// A behavioral 4 GiB trigger is not practical in Node (the guard sits after
// `data = ... arrayBuffer()`, so the entry must actually be 4 GiB), so this
// test pairs the repo's static source-guard convention (brace-matching the
// function body out of Receiver.svelte) with a runtime proof that the REAL
// toast store accepts the 'error' status the handler passes.
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ---- Helper: isolate a function body in the component source by brace matching ----
function extractFunction(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.ok(start !== -1, `${name}() must exist in Receiver.svelte`);
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

// ---- Test 1: static guard — downloadAllFiles guards the zip assembly ----
{
  const source = await readFile(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );
  const body = extractFunction(source, 'downloadAllFiles');

  const zipCall = body.search(/createZipStoreOnly\s*\(/);
  assert.ok(zipCall !== -1, 'downloadAllFiles() must assemble via createZipStoreOnly');

  // The guarded call must sit inside a try { } before it: brace-counting from
  // the function's opening brace to the call position must show we are still
  // inside an open block that a `try` opened.
  const tryIdx = body.lastIndexOf('try', zipCall);
  assert.ok(tryIdx !== -1, 'the createZipStoreOnly call must sit inside a try block');
  const slice = body.slice(tryIdx, zipCall);
  const opens = (slice.match(/{/g) ?? []).length;
  const closes = (slice.match(/}/g) ?? []).length;
  assert.ok(
    opens > closes,
    'the try { ... } block must still be open at the createZipStoreOnly call position'
  );

  // The catch must run AFTER the guarded call and surface the failure through
  // addToastMessage with the 'error' status — otherwise the rejection escapes
  // the onclick handler as an unhandled rejection (silent dead-end).
  const catchIdx = body.search(/catch\s*\(/);
  assert.ok(
    catchIdx !== -1 && catchIdx > zipCall,
    'downloadAllFiles() must have a catch clause after the createZipStoreOnly call'
  );
  const catchClause = body.slice(catchIdx);
  assert.ok(
    /addToastMessage\s*\(/.test(catchClause),
    'the catch must surface the failure via addToastMessage — an escaping rejection means no toast, no feedback'
  );
  assert.ok(catchClause.includes("'error'"), "the rejection toast must carry the 'error' status");

  // Success path unchanged: a zip download is still triggered after assembly.
  const triggerIdx = body.search(/triggerDownload\s*\(/);
  assert.ok(triggerIdx > zipCall, 'the success path must still triggerDownload the assembled zip');
  assert.ok(
    body.includes("'zero-share-files.zip'"),
    'the success path must keep the zero-share-files.zip download name'
  );

  // The button stays wired to this handler (the dead-end was at click time).
  assert.ok(
    /onclick=\{downloadAllFiles\}/.test(source),
    'the bulk-download button must stay wired to downloadAllFiles'
  );

  console.log(
    'ok - downloadAllFiles wraps createZipStoreOnly in try/catch and toasts on rejection'
  );
}

// ---- Test 2: the real toast store surfaces the rejection message as 'error' ----
{
  // toastStore.ts is plain TS (erasable syntax) and nanostores is an installed
  // dependency — dynamic import works natively in Node (same pattern as
  // tests/toast-id-unique.test.mjs).
  const { toastAtom, addToastMessage } = await import(
    join(here, '..', 'src', 'stores', 'toastStore.ts')
  );

  // A real createZipStoreOnly rejection message for a 5 GiB entry.
  const err = new Error(
    'entry "big.bin" is 5.00 GiB; classic ZIP (no zip64) supports entries up to 4 GiB — download this file individually instead'
  );
  // Exact message computation the handler's catch performs.
  const msg = err instanceof Error ? err.message : 'Could not build the ZIP archive';
  addToastMessage(msg, 'error');
  const toast = toastAtom.get();
  assert.ok(
    toast && toast.status === 'error' && toast.message.includes('classic ZIP'),
    "an 'error' toast must land in the store for a 4 GiB entry rejection"
  );
  console.log("ok - toast store surfaces the rejection message with 'error' status");
}

console.log(
  'ok - "Download all files (zip)" surfaces createZipStoreOnly rejections as an error toast instead of an unhandled rejection'
);
