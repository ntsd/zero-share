import { strict as assert } from 'node:assert';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// Regression guard for P0 "files > 2 GiB crash the transfer": MetaData.size was
// int32 on the wire, so Message.encode threw "invalid int32" for any file >= 2 GiB.
// Pinned so a revert to int32 fails the test chain.
//
// The generated src/proto/message.ts contains a TS enum, which Node's strip-only
// type loader cannot import directly (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). We
// transpile it to plain ESM with the already-installed typescript package and
// load the result, so we still exercise the real generated encode/decode.
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
const compiledPath = join(here, '.protocol-size.tmp.js');
await writeFile(compiledPath, compiled.outputText, 'utf8');
try {
  const { Message, MetaData } = await import(compiledPath);

  // 1. A 3 GiB size must encode without throwing (previously: "invalid int32").
  const threeGiB = 3 * 1024 * 1024 * 1024;
  const encoded = Message.encode({
    id: 'file-id',
    metaData: {
      name: 'big.bin',
      size: threeGiB,
      type: 'application/octet-stream',
      key: new Uint8Array(0)
    }
  }).finish();
  assert.ok(
    encoded instanceof Uint8Array && encoded.length > 0,
    'Message.encode must accept a size >= 2 GiB'
  );

  // 2. Round-trip at the 2^53 boundary: values up to Number.MAX_SAFE_INTEGER
  // (2^53 - 1) must survive encode/decode exactly.
  const decoded = Message.decode(encoded, undefined);
  assert.equal(decoded.metaData?.size, threeGiB, '3 GiB size must round-trip exactly');

  const big = Message.decode(
    Message.encode({
      id: 'big-id',
      metaData: { name: 'max.bin', size: Number.MAX_SAFE_INTEGER, type: '', key: new Uint8Array(0) }
    }).finish()
  );
  assert.equal(
    big.metaData?.size,
    Number.MAX_SAFE_INTEGER,
    'size near 2^53 must round-trip exactly'
  );

  // 3. Small sizes still behave identically to the old wire behavior.
  const small = Message.decode(
    Message.encode({
      id: 's',
      metaData: { name: 'a', size: 1024, type: '', key: new Uint8Array(0) }
    }).finish()
  );
  assert.equal(small.metaData?.size, 1024, 'small size must round-trip exactly');
  assert.equal(small.id, 's');
  assert.equal(small.metaData?.name, 'a');

  // 4. Sanity: the raw generated encoder still produces bytes.
  const raw = MetaData.encode({ name: 'a', size: 42, type: '', key: new Uint8Array(0) }).finish();
  assert.ok(raw.length > 0, 'MetaData.encode must produce bytes');
} finally {
  await rm(compiledPath, { force: true });
}

console.log('ok - MetaData.size is int64 on the wire (>2 GiB sizes encode/decode exactly)');
