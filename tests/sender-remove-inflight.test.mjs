// Regression guard for the P1 sender leak: "removing an in-flight (Processing)
// sending file leaks an uncaught TypeError from the async chunk-send pipeline".
//
// In Sender.svelte the chunk pipeline (sendNextChunk / sendBuffer) was driven
// by async continuations that RE-READ the live map entry by key
// (`sendingFiles[key].aesKey`, `.progress`, `.bitrate`) AFTER an `await`
// suspension point (slice.arrayBuffer() / encryptAesGcm()). onRemove deletes
// the map entry (and sets stop=true) while a continuation is still suspended,
// so when that await later resolves the continuation dereferences the now
// `undefined` sendingFiles[key] and throws
//   TypeError: Cannot read properties of undefined (reading 'aesKey'|'progress')
// which escapes the fire-and-forget async event listeners as an unhandled
// promise rejection — no toast, no feedback, transfer state undefined.
//
// The Svelte component is not importable in plain Node, so (matching
// tests/receiver-chunk-order.test.mjs) this test MIRRORS the pipeline logic
// with a mocked encryptAesGcm / arrayBuffer that resolves only AFTER the entry
// has been "removed". It drives both the pre-fix shape (proving the mock
// actually reproduces the race) and the post-fix shape (proving no exception
// leaks and no chunk is sent into the void).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// FileStatus values, mirrored from src/type.ts (Svelte/TS not importable here).
const FileStatus = {
  Pending: 'Pending',
  WaitingAccept: 'WaitingAccept',
  Processing: 'Processing',
  Success: 'Success'
};

// PROGRESS_UPDATE_UI_STEP, mirrored from src/configs.ts.
const PROGRESS_UPDATE_UI_STEP = 3;

const SIZE = 300; // 3 chunks @ 128
const CHUNK = 128;

// A minimal mock of the `file` object the pipeline slices. slice().arrayBuffer()
// is the first suspension point (Sender.svelte line 111).
function makeFile(size, name = 'a.bin') {
  return {
    name,
    size,
    type: 'application/octet-stream',
    slice(start, end) {
      const len = Math.max(0, end - start);
      return {
        arrayBuffer() {
          // Resolves in a later microtask so the pipeline actually suspends.
          return new Promise((resolve) => setTimeout(() => resolve(new ArrayBuffer(len)), 0));
        }
      };
    }
  };
}

// Mock encryptAesGcm: runs `remove` (the user clicking Remove on an in-flight
// file) synchronously BEFORE its promise settles, then resolves in a later
// microtask. The pipeline's post-`await` continuation therefore resumes against
// an already-deleted map entry — the exact race window from the bug report
// (the encryption await is the most plausible suspension point).
function mockEncryptThatRemoves(remove, key, tag) {
  remove(key);
  return new Promise((resolve) => setTimeout(() => resolve(`encrypted:${tag}`), 0));
}

// ---- Test 1: PRE-FIX control — the re-read-after-await shape throws ----------
// Proves the mock latency actually produces the uncaught TypeError (and the
// "send into the void" side effect), i.e. this setup would have caught the
// original bug.
{
  const ID = 'file-1';
  const sendingFiles = {};
  sendingFiles[ID] = {
    file: makeFile(SIZE),
    metaData: {
      name: 'a.bin',
      size: SIZE,
      type: 'application/octet-stream',
      key: new Uint8Array()
    },
    progress: 0,
    bitrate: 0,
    stop: false,
    error: undefined,
    startTime: Date.now(),
    status: FileStatus.Processing,
    aesKey: 'mock-aes-key'
  };

  const key = ID;
  let offset = 0;
  let sends = 0;
  const dataChannel = {
    send() {
      sends++;
    }
  };
  const fileStats = { progress: 0, startTime: Date.now(), nextProgressUpdate: 0 };

  function onRemove(k) {
    if (sendingFiles[k].status === FileStatus.Processing) {
      sendingFiles[k].stop = true;
    }
    delete sendingFiles[k];
  }

  // PRE-FIX shape: re-reads `sendingFiles[key]` after each await.
  async function sendBuffer(buffer) {
    // sendBuffer line 88 (crash site: `.aesKey`)
    const aesKey = sendingFiles[key].aesKey;
    const encrypted = await mockEncryptThatRemoves(onRemove, key, buffer.byteLength);
    dataChannel.send(encrypted); // "send into the void" — pre-fix has no stop guard
  }

  async function sendNextChunk() {
    const slice = sendingFiles[key].file.slice(offset, offset + CHUNK);
    const buffer = await slice.arrayBuffer();
    await sendBuffer(buffer);
    offset += buffer.byteLength;
    fileStats.progress = Math.round((offset / sendingFiles[key].metaData.size) * 100);
    if (fileStats.progress >= fileStats.nextProgressUpdate) {
      // sendNextChunk lines 131/133 (crash sites: `.progress` / `.bitrate`)
      sendingFiles[key].progress = fileStats.progress;
      sendingFiles[key].bitrate = 1;
      fileStats.nextProgressUpdate += PROGRESS_UPDATE_UI_STEP;
    }
  }

  await assert.rejects(
    sendNextChunk(),
    (err) => {
      assert.ok(err instanceof TypeError, 'must be a TypeError, got ' + err.constructor.name);
      assert.match(String(err), /Cannot read properties of undefined/);
      return true;
    },
    'pre-fix pipeline must throw TypeError after removal'
  );
  assert.equal(sends, 1, 'pre-fix also fires a send into the void before it crashes');
  assert.equal(sendingFiles[key], undefined, 'entry was removed mid-flight');
  await delay(10);
  console.log('ok - control: pre-fix re-read-after-await throws uncaught TypeError on removal');
}

// ---- Test 2: POST-FIX — captured reference + stop guard survives removal -----
{
  const ID = 'file-2';
  const sendingFiles = {};
  const sendingFile = (sendingFiles[ID] = {
    file: makeFile(SIZE),
    metaData: {
      name: 'a.bin',
      size: SIZE,
      type: 'application/octet-stream',
      key: new Uint8Array()
    },
    progress: 0,
    bitrate: 0,
    stop: false,
    error: undefined,
    startTime: Date.now(),
    status: FileStatus.Processing,
    aesKey: 'mock-aes-key'
  });

  const key = ID;
  let offset = 0;
  let sends = 0;
  const dataChannel = {
    send() {
      sends++;
    }
  };
  const fileStats = { progress: 0, startTime: Date.now(), nextProgressUpdate: 0 };

  function onRemove(k) {
    const f = sendingFiles[k];
    if (!f) return;
    if (f.status === FileStatus.Processing) {
      f.stop = true;
    }
    delete sendingFiles[k];
  }

  // POST-FIX shape: dereferences the captured `sendingFile` reference and
  // re-checks the stop flag at every resumption point.
  async function sendBuffer(buffer) {
    if (sendingFile.stop) return;
    const aesKey = sendingFile.aesKey; // captured reference — safe after removal
    const encrypted = await mockEncryptThatRemoves(onRemove, key, buffer.byteLength);
    if (sendingFile.stop) return; // Remove during encryption must not send into the void
    dataChannel.send(encrypted);
  }

  async function sendNextChunk() {
    if (sendingFile.stop) return;
    const slice = sendingFile.file.slice(offset, offset + CHUNK);
    const buffer = await slice.arrayBuffer();
    if (sendingFile.stop) return;
    await sendBuffer(buffer);
    if (sendingFile.stop) return;
    offset += buffer.byteLength;
    fileStats.progress = Math.round((offset / sendingFile.metaData.size) * 100);
    if (fileStats.progress >= fileStats.nextProgressUpdate) {
      sendingFile.progress = fileStats.progress; // captured reference — safe
      sendingFile.bitrate = 1;
      fileStats.nextProgressUpdate += PROGRESS_UPDATE_UI_STEP;
    }
  }

  // Must RESOLVE (no exception), not reject.
  await sendNextChunk();
  assert.equal(sends, 0, 'no chunk may be sent after the file was removed');
  assert.equal(sendingFiles[key], undefined, 'entry stays removed');
  assert.equal(sendingFile.stop, true, 'onRemove must have marked the in-flight entry stopped');
  await delay(10);
  console.log('ok - post-fix pipeline resolves cleanly when the file is removed mid-flight');
}

// ---- Test 3: static guard — the real component uses guarded references -------
{
  const senderSource = readFileSync(
    join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
    'utf8'
  );

  // The crash sites: bare `sendingFiles[key].*` re-reads after an await must
  // not exist in the chunk pipeline.
  assert.ok(
    !/sendingFiles\[key\]\.aesKey/.test(senderSource),
    'sendBuffer must not re-read sendingFiles[key].aesKey after an await'
  );
  assert.ok(
    !/sendingFiles\[key\]\.progress/.test(senderSource),
    'sendNextChunk must not re-read sendingFiles[key].progress after an await'
  );
  assert.ok(
    !/sendingFiles\[key\]\.bitrate/.test(senderSource),
    'sendNextChunk must not re-read sendingFiles[key].bitrate after an await'
  );

  // The post-fix shape: the pipeline dereferences the captured `sendingFile`
  // reference (which outlives `delete sendingFiles[key]`) instead.
  assert.ok(
    /const sendingFile = sendingFiles\[key\];\s*if \(!sendingFile\) return;/.test(senderSource),
    'onSend must capture the entry and null-guard it before use'
  );
  assert.ok(
    /sendingFile\.aesKey/.test(senderSource),
    'sendBuffer must read aesKey from the captured sendingFile reference'
  );
  // The progress + bitrate UI writes now run in the shared helper
  // (src/utils/transferProgress.ts, deduplicated from the inline block);
  // the invariant is unchanged in spirit: the WRITE TARGET must be the
  // captured `sendingFile` reference, not a `sendingFiles[key]` re-read,
  // so a Remove mid-pipeline still lands the UI update on the live entry.
  assert.ok(
    /updateTransferProgress\(\s*fileStats\s*,\s*offset\s*,\s*sendingFile\.metaData\.size\s*,\s*sendingFile\s*\)/.test(
      senderSource
    ),
    'sendNextChunk must pass the captured sendingFile reference to updateTransferProgress as the UI write target'
  );

  // The pipeline's stop guard relies on onRemove marking in-flight files and
  // deleting the entry.
  assert.ok(
    /if \(f\.status === FileStatus\.Processing\)\s*\{\s*f\.stop = true;\s*\}/.test(senderSource),
    'onRemove must set stop=true for a Processing file so the pipeline bails out'
  );
  assert.ok(/delete sendingFiles\[key\];/.test(senderSource), 'onRemove must delete the entry');

  console.log(
    'ok - Sender.svelte chunk pipeline dereferences the entry via a null-guarded captured reference'
  );
}

console.log('ok - sender remove-in-flight: chunk pipeline no longer leaks an uncaught TypeError');
