// Regression guard for P1 "successful QR scan leaves camera stream + decode
// worker running — QrScanner.stop() is only ever called from the modal-toggle
// checkbox onchange, never on the programmatic-close / success path".
//
// ScanQrModal.svelte sets `isModalOpen = false` inside the QrScanner decode
// callback when a QR is successfully scanned. A programmatic state change
// updates the DOM `checked` property but does NOT dispatch a `change` event,
// so the checkbox `onchange` handler — the only place stop() was called —
// never runs. The webcam MediaStream and the qr-scanner decode worker kept
// running indefinitely (camera "in use" indicator stayed lit, CPU burn, and
// the camera stayed locked for the rest of the tab session).
//
// The fix:
//   1. The decode callback stops the scanner before invoking onScanSuccess,
//      releasing the camera + worker on the programmatic-close path.
//   2. An onDestroy hook stops the scanner on component unmount, so
//      navigating away mid-scan cannot leak the stream.
//
// This test is static: Node cannot mount Svelte DOM components / open a real
// camera, so it reads src/components/qr/ScanQrModal.svelte and asserts the
// lifecycle guards exist in the source — consistent with
// drag-drop-paste.test.mjs, which guards the onDestroy cleanup of the
// document-level paste listener the same way.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, '..', 'src', 'components', 'qr', 'ScanQrModal.svelte'),
  'utf8'
);

// ---- Helper: slice between two markers (the decode callback body) ----
function extractCallbackBody(source) {
  // The QrScanner constructor takes (video, decodedText => {...}, options);
  // find the arrow callback following the `new QrScanner(` call.
  const ctor = source.search(/new\s+QrScanner\s*\(/);
  assert.ok(ctor !== -1, 'QrScanner constructor call must exist');
  const arrow = source.search(/decodedText[^)]*\)\s*=>\s*\{/, ctor);
  assert.ok(arrow !== -1, 'decode callback (decodedText => ...) must exist');
  const braceStart = source.indexOf('{', arrow);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new assert.AssertionError({ message: 'decode callback: unbalanced braces' });
}

test('decode callback stops the scanner on successful scan (camera released)', () => {
  const body = extractCallbackBody(source);

  assert.ok(
    /onScanSuccess\s*\(/.test(body),
    'decode callback must still deliver the decoded payload to onScanSuccess'
  );
  assert.ok(
    /isModalOpen\s*=\s*false/.test(body),
    'decode callback must close the modal (isModalOpen = false)'
  );

  // The leak: the programmatic isModalOpen = false never fires the checkbox
  // change event, so stop() must be called directly from the callback.
  assert.ok(
    /\bstop\s*\(\s*\)/.test(body),
    'decode callback must call stop() — programmatic close does not trigger the checkbox onchange'
  );

  // stop() must run while the scanner is still the active one: it has to
  // appear in the callback, and before onScanSuccess the payload is passed
  // upward (the parent may unmount the component after acceptAnswer()).
  const stopIndex = body.search(/\bstop\s*\(\s*\)/);
  const successIndex = body.search(/onScanSuccess\s*\(/);
  assert.ok(
    stopIndex !== -1 && stopIndex < successIndex,
    'stop() must run before onScanSuccess so the camera is released even if the parent re-renders on success'
  );
});

test('onDestroy stops the scanner on component unmount', () => {
  assert.ok(
    /onDestroy\s*\(/.test(source),
    'ScanQrModal must register an onDestroy cleanup for the scanner'
  );
  assert.ok(
    /import\s*\{[^}]*onDestroy[^}]*\}\s*from\s*['"]svelte['"]/.test(source),
    'onDestroy must be imported from svelte'
  );

  // The cleanup body must actually stop the scanner (guarded by qrScanner?.
  // via the shared stop() helper).
  const destroyCall = source.match(/onDestroy\s*\(\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(destroyCall, 'onDestroy must wrap a function-body cleanup');
  assert.ok(
    /stop\s*\(\s*\)|stop\s*\(\s*(?:(?!\}).)*qrScanner/.test(destroyCall[1]),
    'onDestroy body must stop the scanner (release the MediaStream)'
  );
});

test('stop() remains the single release point and is undefined-safe', () => {
  const stopBody = source.match(/async\s+function\s+stop\s*\(\s*\)\s*\{([\s\S]*?)\}/);
  assert.ok(stopBody, 'the shared stop() helper must exist');
  assert.ok(
    /qrScanner\?\.stop\s*\(\s*\)/.test(stopBody[1]),
    'stop() must use optional chaining — the scanner is undefined before onMount resolves'
  );

  // The checkbox onchange must keep calling stop() when the user closes the
  // modal manually (feature preserved; double-stop is a no-op in qr-scanner).
  assert.ok(
    /onchange\s*=\s*[\s\S]*?stop\s*\(\s*\)/.test(source),
    'the checkbox onchange must still stop() on manual close'
  );
});
