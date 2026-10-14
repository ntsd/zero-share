// Regression guard for the dedup of the dataChannel.onmessage peer-message
// handler: the identical decode + oneof-routing block (Message.decode guard
// over peer-controlled bytes, then metaData/chunk/receiveEvent dispatch) was
// copy-pasted into OfferPage.svelte and ReceivePage.svelte. Any future
// hardening of the guard (logging, rate-limits, size caps) or a new Message
// oneof variant must now land in exactly one place: src/utils/peerMessage.ts.
//
// Two halves (matching tests/sdp-robustness.test.mjs and
// tests/receiver-key-decryption-failure.test.mjs):
//   1. Static source guard: BOTH pages wire dataChannel.onmessage through
//      handlePeerMessage() from ../utils/peerMessage, and NEITHER page's
//      onmessage body still contains an inline Message.decode( call — the
//      copies are gone, not moved into two more helpers.
//   2. The helper is exercised directly against the REAL generated Message
//      proto (transpiled the same way tests/message-decode-robustness.test.mjs
//      does): malformed bytes -> false + 'Invalid message from peer' toast;
//      valid metaData/chunk/receiveEvent frames -> the matching handler with
//      the right id/args; a frame with no oneof payload set -> false, no
//      handler called (the silent-drop tolerance preserved).
//
// src/proto/message.ts contains a TS enum, which Node's strip-only type
// loader cannot import directly — transpile it (plus the two files
// peerMessage.ts imports) to plain ESM with the already-installed
// typescript package and load the result.
import { strict as assert } from 'node:assert';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');

// Transpile one src/**.ts to the temp tree (same relative path, .js) and
// import it. The source's relative import specifiers carry no extension,
// which Node ESM rejects — rewrite them to the .js siblings we just wrote.
const tmpRoot = join(here, '.peer-message.tmp');
async function loadTranspiled(name) {
  const source = await readFile(join(here, '..', 'src', name), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020
    }
  });
  const out = compiled.outputText.replace(
    /from '(\.[^']+)'/g,
    (match, spec) => `from '${spec}.js'`
  );
  const tmpPath = join(tmpRoot, name.replace(/\.ts$/, '.js'));
  await mkdir(dirname(tmpPath), { recursive: true });
  await writeFile(tmpPath, out, 'utf8');
  return import(tmpPath);
}

// ---- Test 1: static guard — both pages delegate to the shared helper ----
for (const page of ['OfferPage.svelte', 'ReceivePage.svelte']) {
  const source = await readFile(join(here, '..', 'src', 'components', page), 'utf8');

  assert.ok(
    source.includes("import { handlePeerMessage } from '../utils/peerMessage';"),
    `${page} must import handlePeerMessage from ../utils/peerMessage`
  );

  // Isolate the dataChannel.onmessage handler body via brace matching.
  const marker = 'dataChannel.onmessage = (event) => {';
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${page} must still wire dataChannel.onmessage`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        bodyEnd = i + 1;
        break;
      }
    }
  }
  assert.ok(bodyEnd !== -1, `${page}: onmessage handler has unbalanced braces`);
  const body = source.slice(bodyStart, bodyEnd);

  assert.ok(
    body.includes('handlePeerMessage(event'),
    `${page}: onmessage must delegate to handlePeerMessage(event, ...)`
  );
  assert.ok(
    !body.includes('Message.decode('),
    `${page}: onmessage must not carry an inline Message.decode( copy`
  );
  assert.ok(
    !source.includes("'Invalid message from peer'"),
    `${page}: the decode-failure toast belongs to the shared helper, not the page`
  );
  // behavior preserved: the page-local routing still reaches the same targets
  assert.ok(
    /receiver\?\.onMetaData\(id, metaData\);[\s\S]*showNewFile = true/.test(body),
    `${page}: metaData frames must still reach receiver.onMetaData + showNewFile`
  );
  assert.ok(
    body.includes('receiver?.onChunkData(id, chunk)'),
    `${page}: chunk frames must still reach receiver.onChunkData`
  );
  assert.ok(
    body.includes('sender?.onReceiveEvent(id, receiveEvent)'),
    `${page}: receiveEvent frames must still reach sender.onReceiveEvent`
  );
  console.log(`ok - ${page}: onmessage delegates to the shared handlePeerMessage helper`);
}

// ---- Test 2: the helper, driven with real generated Message frames ----
const { Message } = await loadTranspiled('proto/message.ts');
const { toastAtom } = await loadTranspiled('stores/toastStore.ts');
const { handlePeerMessage } = await loadTranspiled('utils/peerMessage.ts');

const toasts = [];
const unsubscribe = toastAtom.subscribe((value) => {
  if (value !== null) toasts.push(value);
});

function makeHandlers() {
  const calls = [];
  return {
    calls,
    handlers: {
      onMetaData: (id, metaData) => calls.push({ fn: 'onMetaData', id, arg: metaData }),
      onChunkData: (id, chunk) => calls.push({ fn: 'onChunkData', id, arg: chunk }),
      onReceiveEvent: (id, receiveEvent) =>
        calls.push({ fn: 'onReceiveEvent', id, arg: receiveEvent })
    }
  };
}

try {
  // 2a. Malformed peer bytes -> false + the exact error toast, no dispatch.
  const malformedPayloads = [
    // field 3, wire-type 2, length 0x7FFFFFFF (varint) -> "premature EOF"
    new Uint8Array([0x1a, 0x80, 0x80, 0x80, 0x80, 0x07]),
    // field 1, wire-type 2, length 10 but only 1 byte follows
    new Uint8Array([0x0a, 0x0a, 0x41]),
    // tag with reserved wire-type 6
    new Uint8Array([0x03])
  ];
  for (const payload of malformedPayloads) {
    const { handlers, calls } = makeHandlers();
    const result = handlePeerMessage({ data: payload }, handlers);
    assert.equal(result, false, 'a malformed frame must return false');
    assert.equal(calls.length, 0, 'a malformed frame must dispatch no handler');
    assert.equal(toasts.length, 1, 'a malformed frame must surface exactly one toast');
    assert.equal(toasts[0].message, 'Invalid message from peer');
    assert.equal(toasts[0].status, 'error');
    toasts.length = 0;
  }
  console.log('ok - malformed peer frames: returns false + Invalid message from peer toast');

  // 2b. Valid metaData frame -> onMetaData with the right id/args, only once.
  {
    const meta = {
      name: 'a.bin',
      size: 1024,
      type: 'application/octet-stream',
      key: new Uint8Array(0)
    };
    const frame = Message.encode({ id: 'f-1', metaData: meta }).finish();
    const { handlers, calls } = makeHandlers();
    assert.equal(handlePeerMessage({ data: frame }, handlers), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'onMetaData');
    assert.equal(calls[0].id, 'f-1');
    assert.equal(calls[0].arg.name, 'a.bin');
    assert.equal(calls[0].arg.size, 1024);
    assert.equal(toasts.length, 0, 'a valid frame must not toast');
  }

  // 2c. Valid chunk frame -> onChunkData with the exact bytes.
  {
    const frame = Message.encode({ id: 'f-2', chunk: new Uint8Array([9, 8, 7, 6]) }).finish();
    const { handlers, calls } = makeHandlers();
    assert.equal(handlePeerMessage({ data: frame }, handlers), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'onChunkData');
    assert.equal(calls[0].id, 'f-2');
    assert.ok(calls[0].arg instanceof Uint8Array);
    assert.deepEqual([...calls[0].arg], [9, 8, 7, 6]);
  }

  // 2d. Valid receiveEvent frame -> onReceiveEvent with the right id/event.
  {
    const frame = Message.encode({ id: 'f-3', receiveEvent: 2 }).finish();
    const { handlers, calls } = makeHandlers();
    assert.equal(handlePeerMessage({ data: frame }, handlers), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'onReceiveEvent');
    assert.equal(calls[0].id, 'f-3');
    assert.equal(calls[0].arg, 2);
  }
  console.log('ok - valid metaData/chunk/receiveEvent frames dispatch to the right handler');

  // 2e. Frame with no oneof payload set -> silently dropped: false, no
  // handler, no toast (the undefined-message tolerance preserved).
  {
    const frame = Message.encode({ id: 'f-4' }).finish();
    const { handlers, calls } = makeHandlers();
    assert.equal(handlePeerMessage({ data: frame }, handlers), false);
    assert.equal(calls.length, 0, 'an empty oneof frame must dispatch no handler');
    assert.equal(toasts.length, 0, 'an empty oneof frame must be dropped silently');
  }
  console.log('ok - empty oneof frame: returned false, no handler, no toast');
} finally {
  unsubscribe();
  await rm(tmpRoot, { recursive: true, force: true });
}

console.log(
  'ok - peer-message handler: both pages share src/utils/peerMessage.ts, decode guard + routing behavior preserved'
);
