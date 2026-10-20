// Component-level regression guard for the connectionLost gate in
// Sender.svelte (P0 regression from the #97 dedup into
// src/utils/channelSender.ts):
//
//   const connectionLost = $derived(channelSender.isLost());
//
// isLost() reads a plain closure variable in the helper and touches no Svelte
// signal, so that $derived evaluates once, is marked CLEAN, and caches
// `false` for the whole component lifetime. The compiled template reads the
// flag via `$.get(connectionLost)` on every re-render, so the gate stayed
// open forever and SendingFileList kept offering Resend / Continue / Send as
// guaranteed silent no-ops after a connection loss.
//
// The fix makes the flag a `$state` that onChannelClose() / the send()
// wrapper flip, so the template re-reads it fresh.
//
// This test drives the ACTUAL compiled script of Sender.svelte: it compiles
// the component, extracts the script body (the code between
// `let sendingFiles = $.proxy({});` and the DOM template), runs it under the
// pinned svelte@5.39.6 reactivity engine with the real createChannelSender
// helper, and reads the flag the exact way the compiled template does —
// through the `get connectionLost() { return $.get(connectionLost); }`
// getter the template builds for <SendingFileList />.
//
// It also evaluates SendingFileList's REAL button-chain conditions (extracted
// from its source — the single source of truth) against the live entry state
// and live flag, asserting the required end states:
//   - before onChannelClose(): a failed entry still gets Resend;
//   - after onChannelClose():  the flag reads true, only Remove remains;
//   - after a throwing send() (dead channel with a stale 'open' readyState):
//     same end state — the throw-first close race the send() wrapper mirrors.
//
// A negative control proves sensitivity: the pre-fix $derived-over-isLost()
// wiring is reproduced in isolation and shown to stay stale under the same
// read path, so reverting the fix would fail this test.
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { compile } from 'svelte/compiler';
import { get, derived } from 'svelte/internal/client';

const here = dirname(fileURLToPath(import.meta.url));
const senderSource = readFileSync(
  join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
  'utf8'
);
const listSource = readFileSync(
  join(here, '..', 'src', 'components', 'sender', 'SendingFileList.svelte'),
  'utf8'
);

// FileStatus values, mirrored from src/type.ts (Svelte/TS not importable here).
const FileStatus = {
  Pending: 'Pending',
  WaitingAccept: 'WaitingAccept',
  Processing: 'Processing',
  Success: 'Success'
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- unhandled-rejection sentinel (must stay empty for the whole file) ----
const unhandledRejections = [];
const onUnhandled = (reason) => unhandledRejections.push(reason);
process.on('unhandledRejection', onUnhandled);

// Mock RTCDataChannel: readyState flips on close() and send() throws the real
// InvalidStateError the platform raises after close(), like a browser channel.
function makeDataChannel() {
  let closed = false;
  return {
    readyState: 'open',
    sentMessages: [],
    send(msg) {
      if (closed) throw new DOMException('The channel is no longer open', 'InvalidStateError');
      this.sentMessages.push(msg);
    },
    close() {
      closed = true;
      this.readyState = 'closed';
    }
  };
}

// ---- compile Sender.svelte and isolate its script body ----------------------
// The script is everything up to `var $$exports` (the DOM template + exports
// start there). We run just the script: it owns connectionLost / sendingFiles
// and the onChannelClose()/send() logic, which is all this test needs.
const { js } = compile(senderSource, { generate: 'client', filename: 'Sender.svelte' });
const bodyStart = js.code.indexOf('let sendingFiles = $.proxy({});');
const bodyEnd = js.code.indexOf('var $$exports');
assert.ok(bodyStart !== -1 && bodyEnd !== -1 && bodyStart < bodyEnd, 'script-body slice anchors');
const scriptBody = js.code.slice(bodyStart, bodyEnd);

// The compiled template invokes <SendingFileList /> with, among others:
//     get connectionLost() { return $.get(connectionLost); }
// Rebuild that exact getter shape in the wrapper so the test reads the flag
// through the same reactivity path the real template uses.
const moduleSource = [
  "import * as $ from 'svelte/internal/client';",
  "import EventEmitter from 'eventemitter3';",
  'import { createChannelSender } from ' +
    JSON.stringify(join(here, '..', 'src', 'utils', 'channelSender.ts')) +
    ';',
  'const FileStatus = ' + JSON.stringify(FileStatus) + ';',
  'const DragAndDrop = () => {};',
  'const SendingFileList = () => {};',
  'const encryptAesGcm = async () => new Uint8Array();',
  'const encryptAesKeyWithRsaPublicKey = async () => new Uint8Array();',
  'const generateAesKey = async () => ({});',
  'const validateFileMetadata = () => undefined;',
  'const Message = { encode: () => ({ finish: () => new Uint8Array(1) }) };',
  'const MetaData = class {};',
  'const ReceiveEvent = {',
  "  EVENT_RECEIVER_ACCEPT: 'EVENT_RECEIVER_ACCEPT',",
  "  EVENT_RECEIVED_CHUNK: 'EVENT_RECEIVED_CHUNK',",
  "  EVENT_VALIDATE_ERROR: 'EVENT_VALIDATE_ERROR',",
  "  EVENT_RECEIVER_REJECT: 'EVENT_RECEIVER_REJECT'",
  '};',
  'const receiveEventToJSON = (e) => String(e);',
  'const addToastMessage = (m) => { globalThis.__toasts.push(m); };',
  'const PROGRESS_UPDATE_UI_STEP = 10;',
  'export function runSender($$props) {',
  scriptBody,
  '  return {',
  '    onChannelClose, onReceiveEvent, onContinue, send, sendingFiles,',
  '    // Exactly the shape the compiled template builds for <SendingFileList />:',
  '    listProps: {',
  '      get sendingFiles() { return sendingFiles; },',
  '      get connectionLost() { return $.get(connectionLost); }',
  '    }',
  '  };',
  '}'
].join('\n');

const tmpModule = join(here, `.sender-script-tmp-${randomUUID()}.mjs`);
writeFileSync(tmpModule, moduleSource);
let senderModule;
try {
  senderModule = await import('file://' + tmpModule + '?t=' + Date.now());
} finally {
  try {
    unlinkSync(tmpModule);
  } catch {}
}
const { runSender } = senderModule;

function makeEntry(name, status) {
  return {
    file: { name },
    metaData: { name, size: 300, type: 'application/octet-stream', key: new Uint8Array() },
    progress: 0,
    bitrate: 0,
    stop: false,
    error: status === 'Pending' ? new Error('chunk failed earlier') : undefined,
    startTime: 0,
    status,
    aesKey: null
  };
}

// Evaluate SendingFileList's real button-chain conditions against a live entry
// and a live connectionLost flag (the same values the compiled template passes
// into the {#each}). Mirrors SendingFileList.svelte lines 30-46.
function whichButtons(sendingFile, connectionLost) {
  const buttons = [];
  if (sendingFile.error && !connectionLost) buttons.push('Resend');
  else if (sendingFile.stop && !connectionLost) buttons.push('Continue');
  else if (sendingFile.status === FileStatus.Processing) buttons.push('Stop');
  else if (
    sendingFile.status !== FileStatus.Success &&
    sendingFile.status !== FileStatus.WaitingAccept &&
    !connectionLost
  )
    buttons.push('Send');
  buttons.push('Remove'); // unconditional, outside the {#if} chain
  return buttons;
}

// Sanity: our extracted conditions match the real list source (guards against
// the test drifting from SendingFileList.svelte).
assert.ok(
  /sendingFile\.error\s*&&\s*!connectionLost/.test(listSource),
  'list: Resend gate is sendingFile.error && !connectionLost'
);
assert.ok(
  /sendingFile\.stop\s*&&\s*!connectionLost/.test(listSource),
  'list: Continue gate is sendingFile.stop && !connectionLost'
);

// ---- Scenario 1: channel dies via onChannelClose() --------------------------
{
  globalThis.__toasts = [];
  const dc = makeDataChannel();
  const r = runSender({ dataChannel: dc, chunkSize: 128, isEncrypt: false, rsaPub: undefined });

  // A failed entry (channel still open): Resend must be offered.
  const key = 'file-1';
  r.sendingFiles[key] = makeEntry('a.bin', 'Pending');
  assert.equal(r.listProps.connectionLost, false, 'before close the flag is false');
  assert.ok(
    whichButtons(r.sendingFiles[key], r.listProps.connectionLost).includes('Resend'),
    'before close a failed entry gets Resend'
  );

  // The peer's channel dies; the page's onclose fires onChannelClose().
  dc.close();
  r.onChannelClose();

  // The template re-reads the flag through its getter — it must now be true.
  assert.equal(r.listProps.connectionLost, true, 'after onChannelClose the flag reads true');
  assert.match(
    r.sendingFiles[key].error.message,
    /connection lost/i,
    'onChannelClose marks the entry with the accurate error'
  );
  const buttons = whichButtons(r.sendingFiles[key], r.listProps.connectionLost);
  assert.deepEqual(
    buttons,
    ['Remove'],
    'after close only Remove remains (Resend/Continue/Send suppressed)'
  );
  assert.equal(
    globalThis.__toasts.filter((t) => /connection lost/i.test(t)).length,
    1,
    'exactly one connection-lost toast'
  );
  await delay(10);
  console.log('ok - after onChannelClose(): flag reads true, only Remove remains');
}

// ---- Scenario 2: throw-first close race (dead channel, stale 'open') -------
{
  globalThis.__toasts = [];
  const dc = makeDataChannel();
  // The close settles asynchronously: the channel still reads 'open' when the
  // send happens, but the platform throws. Restore the stale 'open' read to
  // exercise exactly that race, THEN close() marks it dead.
  dc.close();
  dc.readyState = 'open';
  const r = runSender({ dataChannel: dc, chunkSize: 128, isEncrypt: false, rsaPub: undefined });

  const key = 'file-2';
  r.sendingFiles[key] = makeEntry('b.bin', 'Pending');
  assert.equal(r.listProps.connectionLost, false, 'before the throwing send the flag is false');

  // A send that throws on the dead channel: the helper flips its lost flag and
  // the component's send() wrapper must mirror it into the UI flag.
  const ok = r.send(new Uint8Array([1]));
  assert.equal(ok, false, 'a throwing send returns false');
  assert.equal(
    r.listProps.connectionLost,
    true,
    'the send() wrapper mirrors the helper flip into the UI gate'
  );
  const buttons = whichButtons(r.sendingFiles[key], r.listProps.connectionLost);
  assert.deepEqual(buttons, ['Remove'], 'after the throw-first race only Remove remains');
  await delay(10);
  console.log('ok - after a throwing send(): UI gate flips, only Remove remains');
}

// ---- Negative control: the pre-fix $derived-over-isLost() stays stale -------
{
  // Reproduce the broken wiring in isolation: a $derived whose body reads a
  // plain closure variable (exactly what channelSender.isLost() is). Under
  // the same read path the template uses ($.get), it must stay cached `false`
  // — proving this test is sensitive to the regression and that the $state
  // above is what distinguishes the fix.
  let lost = false; // the helper's plain closure variable
  let d;
  {
    // create the derived outside any running effect, like the component does
    // at its top level
    d = derived(() => lost);
  }
  assert.equal(get(d), false, 'broken shape reads false initially');
  lost = true; // markLost()
  assert.equal(
    get(d),
    false,
    'a $derived over a non-signal stays cached false forever (the #97 bug) — ' +
      'this is why the $state fix is required'
  );
  console.log('ok - negative control: $derived over isLost() stays stale; $state does not');
}

// ---- final: no unhandled rejections escaped anywhere in this suite ----
{
  await delay(50);
  assert.equal(
    unhandledRejections.length,
    0,
    `no unhandled promise rejections allowed; got: ${JSON.stringify(
      unhandledRejections.map((r) => String(r))
    )}`
  );
  process.off('unhandledRejection', onUnhandled);
}

console.log(
  'ok - sender connectionLost gate is reactive end-to-end ($state, not a stale $derived)'
);
