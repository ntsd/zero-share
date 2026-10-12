// Regression guard for P0 "Message.decode on peer-controlled data-channel
// bytes has no guard — malformed/truncated protobuf frame crashes the page":
// both pages wire dataChannel.onmessage to Message.decode(new
// Uint8Array(event.data)) with no try/catch. The bytes on the WebRTC data
// channel are controlled by the remote peer, so a malformed or truncated
// frame (e.g. a length-delimited tag whose length exceeds the remaining
// bytes) makes Message.decode throw synchronously ("RangeError: premature
// EOF"); the exception escaped the onmessage handler as an uncaught error,
// stalling the transfer with no user feedback.
//
// The Svelte handler change itself cannot be exercised under Node, so this
// test is scoped to the decode primitive (the thing that throws), matching
// tests/protocol-size.test.mjs:
//   1. Message.decode throws on the crafted malformed payloads.
//   2. A valid frame still round-trips through the real generated
//      encode/decode.
//
// The generated src/proto/message.ts contains a TS enum, which Node's
// strip-only type loader cannot import directly (ERR_UNSUPPORTED_TYPESCRIPT_
// SYNTAX). We transpile it to plain ESM with the already-installed
// typescript package and load the result.
import { strict as assert } from 'node:assert';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const tsSourcePath = join(here, '..', 'src', 'proto', 'message.ts');
const tsSource = await readFile(tsSourcePath, 'utf8');

const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiled = ts.transpileModule(tsSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020
  }
});
// Write next to the test file so Node resolves @bufbuild/protobuf/wire from node_modules
const compiledPath = join(here, '.message-decode.tmp.js');
await writeFile(compiledPath, compiled.outputText, 'utf8');
try {
  const { Message } = await import(compiledPath);

  // 1. Crafted peer bytes must make Message.decode throw (documenting the
  //    throwing behavior the page-side try/catch relies on).
  const malformedPayloads = [
    // field 3, wire-type 2, length 0x7FFFFFFF (varint) — far more bytes than
    // remain -> "premature EOF"
    new Uint8Array([0x1a, 0x80, 0x80, 0x80, 0x80, 0x07]),
    // field 1, wire-type 2, length 10 but only 1 byte follows
    new Uint8Array([0x0a, 0x0a, 0x41]),
    // tag with reserved wire-type 6
    new Uint8Array([0x03])
  ];
  for (const payload of malformedPayloads) {
    let threw = false;
    try {
      Message.decode(payload);
    } catch {
      threw = true;
    }
    assert.ok(
      threw,
      `Message.decode must throw on malformed payload ${Buffer.from(payload).toString('hex')}`
    );
  }
  console.log('ok - Message.decode throws on malformed/truncated peer payloads');

  // 2. Valid frames still round-trip through the generated encode/decode:
  //    each of the three oneof variants (metaData, chunk, receiveEvent).
  const metaDataMsg = Message.encode({
    id: 'f-1',
    metaData: {
      name: 'a.bin',
      size: 1024,
      type: 'application/octet-stream',
      key: new Uint8Array(0)
    }
  }).finish();
  const decodedMeta = Message.decode(metaDataMsg);
  assert.equal(decodedMeta.id, 'f-1');
  assert.equal(decodedMeta.metaData?.name, 'a.bin');
  assert.equal(decodedMeta.metaData?.size, 1024);

  const chunkMsg = Message.encode({
    id: 'f-1',
    chunk: new Uint8Array([1, 2, 3, 4, 255])
  }).finish();
  const decodedChunk = Message.decode(chunkMsg);
  assert.equal(decodedChunk.id, 'f-1');
  assert.ok(decodedChunk.chunk instanceof Uint8Array, 'chunk must decode to a Uint8Array');
  assert.deepEqual([...decodedChunk.chunk], [1, 2, 3, 4, 255]);

  const eventMsg = Message.encode({
    id: 'f-1',
    receiveEvent: 2 // EVENT_RECEIVED_CHUNK
  }).finish();
  const decodedEvent = Message.decode(eventMsg);
  assert.equal(decodedEvent.id, 'f-1');
  assert.equal(decodedEvent.receiveEvent, 2);
  console.log('ok - valid frames round-trip through Message.encode/decode');
} finally {
  await rm(compiledPath, { force: true });
}

console.log(
  'ok - Message.decode robustness: malformed peer frames throw (guarded page-side), valid frames round-trip'
);
