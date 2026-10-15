// Regression guard for P0 "copyLink/copyAnswerCode clipboard failures escape
// as unhandled rejection": copyOfferLink() (OfferPage.svelte) and
// copyAnswerCode() (ReceivePage.svelte) were bare
//
//     await navigator.clipboard.writeText(...);
//     addToastMessage('Copied to clipboard', 'info');
//
// bound directly to button onclick handlers. `navigator.clipboard.writeText`
// rejects with SecurityError (non-secure context), NotAllowedError (user
// denies the permission prompt), DataError (invalid/empty text) — and
// `navigator.clipboard` is undefined (TypeError) in some webviews / older
// Safari private mode. With no try/catch and no global
// unhandledrejection handler, the failure was completely silent: no toast,
// nothing in the clipboard, and the user believed the link/answer was
// copied — dead-ending the manual P2P handshake with zero diagnostic.
//
// The fix (matching every other user-action handler in these pages): wrap
// the writeText call in try/catch; the catch surfaces a visible error toast
// telling the user to copy the text manually.
//
// Node cannot mount the Svelte components, so (mirroring the static-source
// style of tests/sdp-robustness.test.mjs) this test (1) statically asserts
// that BOTH handlers wrap navigator.clipboard.writeText in a try/catch whose
// catch calls addToastMessage(..., 'error'), and (2) dynamically executes
// the extracted handler bodies against a stubbed navigator to prove:
//   - a rejected writeText surfaces the error toast and does NOT throw out
//     of the handler (no unhandled rejection),
//   - an absent navigator.clipboard (TypeError) is handled the same way,
//   - the success path still writes the value and shows the info toast.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ---- Helper: find the body of a named function in the Svelte source ----
function extractFunction(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.ok(start !== -1, `${name}() must exist`);
  // Walk from the first `{` after the signature, balancing braces to find
  // the end of the function body.
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
// try portion contains the navigator.clipboard.writeText call and whose
// catch portion calls addToastMessage(..., 'error'). The try portion must
// also keep the success toast ('Copied to clipboard', 'info').
function assertGuardedCopy(funcBody, context) {
  const tryRe = /try\s*\{([\s\S]*?)\}\s*catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}/;
  const m = funcBody.match(tryRe);
  assert.ok(m, `${context}: a try/catch must wrap the clipboard write`);
  const [tryBody, catchBody] = [m[1], m[2]];
  assert.ok(
    /navigator\.clipboard\.writeText\s*\(/.test(tryBody),
    `${context}: navigator.clipboard.writeText must live inside the try`
  );
  assert.ok(
    /addToastMessage\s*\(\s*['"`]Copied to clipboard['"`]\s*,\s*['"`]info['"`]/.test(tryBody),
    `${context}: the success path must keep the 'Copied to clipboard' info toast inside the try`
  );
  assert.ok(
    /addToastMessage\s*\(\s*[\s\S]{0,200}'error'/.test(catchBody),
    `${context}: the catch must call addToastMessage(..., 'error')`
  );
  // The success toast must not also live in the catch — a "Copied" toast on
  // failure would be exactly the lying-feedback this task fixes.
  assert.ok(
    !/Copied to clipboard/.test(catchBody),
    `${context}: the catch must not claim the copy succeeded`
  );
}

// ---- Test 1 (static): OfferPage.svelte copyOfferLink is guarded ----------
{
  const source = readFileSync(join(here, '..', 'src', 'components', 'OfferPage.svelte'), 'utf8');
  assertGuardedCopy(extractFunction(source, 'copyOfferLink'), 'OfferPage.svelte copyOfferLink');
  console.log('ok - OfferPage.svelte: copyOfferLink guards clipboard write with try/catch + toast');
}

// ---- Test 2 (static): ReceivePage.svelte copyAnswerCode is guarded --------
{
  const source = readFileSync(join(here, '..', 'src', 'components', 'ReceivePage.svelte'), 'utf8');
  assertGuardedCopy(extractFunction(source, 'copyAnswerCode'), 'ReceivePage.svelte copyAnswerCode');
  console.log(
    'ok - ReceivePage.svelte: copyAnswerCode guards clipboard write with try/catch + toast'
  );
}

// ---- Dynamic simulation: execute the real handler bodies -----------------
// Compile the extracted function body (from the actual .svelte source, so no
// copy can drift) and drive it against a stubbed navigator + addToastMessage.
// The extracted block is the body of an `async function` containing `await`,
// so wrap it in an async IIFE to make the awaits legal.
async function runCopyHandler(source, funcName, valueParam, value) {
  const body = extractFunction(source, funcName);
  const make = (navigator, calls) =>
    new Function(valueParam, 'navigator', 'addToastMessage', `(async () => ${body})()`)(
      value,
      navigator,
      (msg, type) => calls.push([msg, type])
    );

  // Failure mode 1: writeText rejects (NotAllowedError — permission denied,
  // SecurityError — non-secure context). Must surface an error toast and
  // not escape as a rejection from the handler.
  {
    const calls1 = [];
    let escaped = null;
    try {
      await make(
        {
          clipboard: {
            writeText() {
              return Promise.reject(new DOMException('permission denied', 'NotAllowedError'));
            }
          }
        },
        calls1
      );
    } catch (e) {
      escaped = e;
    }
    assert.equal(escaped, null, 'the handler must not let the writeText rejection escape');
    assert.equal(calls1.length, 1, 'on a rejected write exactly one toast must fire');
    assert.equal(calls1[0][1], 'error', 'on a rejected write the toast must be an error');
  }

  // Failure mode 2: navigator.clipboard is undefined (webviews, older
  // Safari private mode) — a TypeError, not a rejection.
  {
    const calls2 = [];
    let escaped = null;
    try {
      await make({}, calls2);
    } catch (e) {
      escaped = e;
    }
    assert.equal(
      escaped,
      null,
      'the handler must not let the undefined-clipboard TypeError escape'
    );
    assert.equal(calls2.length, 1, 'on an absent clipboard exactly one error toast must fire');
    assert.equal(calls2[0][1], 'error');
  }

  // Success path: the value is written AND the info toast still shows.
  {
    const written = [];
    const calls3 = [];
    await make(
      {
        clipboard: {
          async writeText(text) {
            written.push(text);
          }
        }
      },
      calls3
    );
    assert.deepEqual(written, [value], 'the success path must write the value to the clipboard');
    assert.deepEqual(calls3, [['Copied to clipboard', 'info']]);
  }
}

// ---- Test 3 (dynamic): both handlers behave correctly on all three paths --
{
  const offerSource = readFileSync(
    join(here, '..', 'src', 'components', 'OfferPage.svelte'),
    'utf8'
  );
  await runCopyHandler(
    offerSource,
    'copyOfferLink',
    'offerLink',
    'https://share.example/?o=abc123'
  );
  console.log(
    'ok - copyOfferLink: rejected/absent clipboard toasts an error, success still copies'
  );

  const receiveSource = readFileSync(
    join(here, '..', 'src', 'components', 'ReceivePage.svelte'),
    'utf8'
  );
  await runCopyHandler(receiveSource, 'copyAnswerCode', 'answerSDP', 'sdp-payload|keyB64');
  console.log(
    'ok - copyAnswerCode: rejected/absent clipboard toasts an error, success still copies'
  );
}

console.log('ok - clipboard copy robustness: no silent unhandled rejections, visible errors');
