// Regression guard for P1 "resend leaves the file's UI progress bar stuck at
// the previous attempt's percentage": onSend() (Resend / Send / "Send all
// files") resets the attempt-scoped UI values on the SendingFile entry —
// error, stop, bitrate, startTime — so a re-transfer starts clean, but it did
// NOT reset `f.progress`. `progress` is exactly the field the shared
// updateTransferProgress() helper (src/utils/transferProgress.ts) writes into
// the UI entry (writingTo.progress), driven by the fresh per-attempt fileStats
// throttle, so a Resend of a file that reached 80% before failing kept
// showing 80% from the Resend click until the first acked chunk of the new
// attempt ticked the throttle — "almost done" while the transfer actually
// restarts from byte 0.
//
// The fix adds `sendingFile.progress = 0;` to onSend()'s reset block. This
// test does not copy-paste the reset logic (a mirror would only pin the
// mirror): it extracts the reset block from the REAL Sender.svelte source and
// executes it against a seeded entry — proving the shipped source clears the
// stale progress — then feeds one acked chunk of the new attempt through the
// REAL shared helper, proving the bar is 0 in the resend->first-chunk window
// and the new attempt ticks the bar forward normally (the reset is not so
// aggressive it dead-ends the UI).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const senderSource = readFileSync(
  join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
  'utf8'
);

// updateTransferProgress carries a local value import (`../configs`, no file
// extension) that Node ESM refuses to resolve directly. Transpile the real
// source with the already-installed typescript package and rewrite that import
// to the absolute .ts path, so the REAL function (not a copy that can drift)
// is exercised — the same convention as tests/transfer-progress.test.mjs.
async function loadTranspiled(name, fromDir) {
  const source = await readFile(join(here, '..', 'src', fromDir, name), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020
    }
  });
  const srcDir = join(here, '..', 'src', fromDir);
  const fixed = compiled.outputText.replace(/from ['"](\.[^'"]+)['"]/g, (_all, spec) => {
    const withExt = /\.(ts|js|mjs|json)$/.test(spec) ? spec : `${spec}.ts`;
    const resolved = join(dirname(join(srcDir, name)), withExt);
    return `from '${resolved.replace(/\\/g, '/')}'`;
  });
  const tmpPath = join(here, `.sender-resend-progress.tmp-${name}.js`);
  const { writeFile, rm } = await import('node:fs/promises');
  await writeFile(tmpPath, fixed, 'utf8');
  try {
    return await import(tmpPath);
  } finally {
    await rm(tmpPath, { force: true });
  }
}

const { updateTransferProgress } = await loadTranspiled('transferProgress.ts', 'utils');

// One entry-shaped seed: a 1000-byte file that a previous attempt drove to
// 80% before failing mid-transfer (Pending + error — the Resend-button state).
function seedResendEntry() {
  return {
    file: {},
    metaData: {
      name: 'big.bin',
      size: 1000,
      type: 'application/octet-stream',
      key: new Uint8Array()
    },
    progress: 80,
    bitrate: 42_000,
    stop: false,
    startTime: 1700000000000,
    status: 'Pending',
    error: new Error('Failed to send chunk: mock')
  };
}

// ---- Block 1: the shipped onSend() reset block clears the stale progress ----
// The reset block runs BEFORE `sendingFile.event = new EventEmitter();`, so it
// is the contiguous slice from the `// reset value` marker through
// `sendingFile.progress = 0;`. Executing the REAL source text is the whole
// point — a drift that drops or reorders the progress reset fails here.
{
  const blockStart = senderSource.indexOf('// reset value');
  const blockEnd = senderSource.indexOf('sendingFile.progress = 0;');
  assert.ok(
    blockStart !== -1 && blockEnd > blockStart,
    'onSend() must carry the attempt-scoped reset block with a progress reset'
  );
  const resetBlock = senderSource.slice(blockStart, blockEnd + 'sendingFile.progress = 0;'.length);
  // The reset must stay BEFORE the fresh event emitter is installed: a resend
  // clears the entry first, then wires this attempt's listeners.
  assert.ok(
    /sendingFile\.event = new EventEmitter\(\);/.test(
      senderSource.slice(blockEnd + 1, blockEnd + 80)
    ),
    'the reset block must come before the fresh event emitter is installed'
  );

  const entry = seedResendEntry();
  const runResetBlock = new Function('sendingFile', resetBlock);
  runResetBlock(entry);

  assert.equal(
    entry.progress,
    0,
    'the resend must clear the prior attempt\u2019s progress from the UI entry'
  );
  assert.equal(entry.bitrate, 0, 'the resend must zero the stale bitrate');
  assert.equal(entry.startTime, 0, 'the resend must zero the stale start clock');
  assert.equal(entry.error, undefined, 'the resend must clear the prior error');
  assert.equal(entry.stop, false, 'the resend must clear the stop flag');
  console.log('ok - block 1: the shipped onSend() reset block clears progress/bitrate/startTime');
}

// ---- Block 2: the first-send case stays a clean no-op ----
// onFilesPick() registers a fresh entry with progress: 0 — running the SAME
// reset block against that shape must not disturb it (the resend correction
// must not change first-send behavior).
{
  const blockStart = senderSource.indexOf('// reset value');
  const blockEnd = senderSource.indexOf('sendingFile.progress = 0;');
  const resetBlock = senderSource.slice(blockStart, blockEnd + 'sendingFile.progress = 0;'.length);

  // Registration shape as written in onFilesPick() below.
  const registerIdx = senderSource.indexOf('sendingFiles[id] = {');
  assert.ok(registerIdx !== -1, 'onFilesPick() must register the entry');
  const registration = senderSource.slice(registerIdx, senderSource.indexOf('};', registerIdx));
  assert.ok(
    /progress:\s*0/.test(registration),
    'onFilesPick() must register a fresh entry with progress: 0'
  );

  const entry = {
    file: {},
    metaData: {
      name: 'fresh.bin',
      size: 1000,
      type: 'application/octet-stream',
      key: new Uint8Array()
    },
    progress: 0,
    bitrate: 0,
    stop: false,
    startTime: 0,
    status: 'Pending'
  };
  new Function('sendingFile', resetBlock)(entry);
  assert.equal(entry.progress, 0, 'a first send must stay at 0% through the reset');
  assert.equal(entry.bitrate, 0, 'a first send must stay at 0 bitrate');
  assert.equal(entry.startTime, 0, 'a first send must stay at a 0 start clock');
  console.log('ok - block 2: the reset block is a no-op for a freshly-picked file');
}

// ---- Block 3: the new attempt's first chunk ticks the bar forward ----
// After the reset, the entry sits at 0% until the first acked chunk. Feed one
// 100-byte chunk of the new attempt through the REAL shared helper with a
// fresh per-attempt fileStats (exactly what onSend() allocates), and the UI
// entry must move from the cleared 0 to the real new-attempt percentage — the
// reset cleared the stale value, it did not pin the bar to 0.
{
  const entry = seedResendEntry();
  entry.progress = 0;
  entry.bitrate = 0;
  entry.startTime = 0;

  // The onSend -> Resend -> WaitingAccept window: no chunks acked yet.
  assert.equal(entry.progress, 0, 'before the first chunk the bar must read 0%');

  const fileStats = { progress: 0, startTime: Date.now(), nextProgressUpdate: 0 };
  updateTransferProgress(fileStats, 100, entry.metaData.size, entry);
  assert.equal(
    entry.progress,
    10,
    'the new attempt\u2019s first acked chunk must update the UI progress'
  );
  assert.ok(
    entry.bitrate > 0,
    'the new attempt\u2019s first acked chunk must update the UI bitrate'
  );
  console.log('ok - block 3: the new attempt drives the freshly-cleared bar forward');
}

// ---- Block 4: the UI entry is what the card renders, and the receiver is
// already correct (this fix is sender-only) ----
{
  const fileCardSource = readFileSync(
    join(here, '..', 'src', 'components', 'FileCard.svelte'),
    'utf8'
  );
  assert.ok(
    /<progress[^>]*\n\s*value=\{[^}]*progress[^}]*\}/.test(fileCardSource),
    'FileCard must render the entry\u2019s progress field in the <progress> bar'
  );

  const receiverSource = readFileSync(
    join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
    'utf8'
  );
  const receiverRegisterIdx = receiverSource.indexOf('receivingFiles[id] = {');
  assert.ok(
    receiverRegisterIdx !== -1 &&
      /progress:\s*0/.test(receiverSource.slice(receiverRegisterIdx, receiverRegisterIdx + 400)),
    'the receiver must register its entry with progress: 0 (already correct)'
  );
  console.log('ok - block 4: FileCard renders entry.progress; the receiver already resets it');
}

console.log('ok - sender resend: the entry\u2019s stale progress bar is cleared on Resend');
