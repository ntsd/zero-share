import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for the P0 sender hang: after onSend set
// status = FileStatus.WaitingAccept, the sender's only way out was a
// receiver ACCEPT/REJECT/VALIDATE_ERROR message on the data channel. With no
// timeout and no channel-close handling, a receiver whose RSA key decryption
// fails (or whose tab closes) left every pending file stuck in
// "Waiting Accept" forever, with no Send/Resend button. The fix adds a
// per-file WAIT_ACCEPT_TIMEOUT timer that fails the file back to Pending with
// an error, plus an onChannelClose that fails all WaitingAccept files.
// Sender.svelte is a Svelte component (not importable in plain Node), so the
// fixture below mirrors the timer state machine with real (short) timers, and
// the last block statically guards that the fix is wired into the component.
const here = dirname(fileURLToPath(import.meta.url));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Short stand-in for WAIT_ACCEPT_TIMEOUT so the suite runs in milliseconds.
const WAIT_ACCEPT_TIMEOUT = 40;

// Mirror of Sender.svelte's WaitingAccept liveness guard: the status values
// are the literal FileStatus enum strings, and the timer semantics (start on
// WaitingAccept, self-exit guard, clear on every exit path) are exactly the
// part under test.
const FileStatus = {
  Pending: 'Pending',
  WaitingAccept: 'WaitingAccept',
  Processing: 'Processing',
  Success: 'Success'
};

function newFixture() {
  const state = {
    sendingFiles: {},
    waitAcceptTimers: {},
    toasts: []
  };

  state.addToast = (message, type) => state.toasts.push({ message, type });

  state.failWaitingAccept = (key, message) => {
    state.sendingFiles[key].error = new Error(message);
    state.sendingFiles[key].status = FileStatus.Pending;
    state.addToast(`File ${state.sendingFiles[key].metaData.name} failed: ${message}`, 'error');
  };

  state.clearWaitAcceptTimer = (key) => {
    if (state.waitAcceptTimers[key]) {
      clearTimeout(state.waitAcceptTimers[key]);
      delete state.waitAcceptTimers[key];
    }
  };

  state.startWaitAcceptTimer = (key) => {
    state.clearWaitAcceptTimer(key);
    state.waitAcceptTimers[key] = setTimeout(() => {
      delete state.waitAcceptTimers[key];
      if (state.sendingFiles[key]?.status !== FileStatus.WaitingAccept) {
        return; // accepted/rejected/removed in the meantime
      }
      state.failWaitingAccept(key, 'No response from receiver (timed out waiting for accept)');
    }, WAIT_ACCEPT_TIMEOUT);
  };

  state.onChannelClose = () => {
    for (const key of Object.keys(state.waitAcceptTimers)) {
      state.clearWaitAcceptTimer(key);
      if (state.sendingFiles[key]?.status === FileStatus.WaitingAccept) {
        state.failWaitingAccept(key, 'Disconnected from receiver');
      }
    }
  };

  // Mirrors onSend's tail: status = WaitingAccept; startWaitAcceptTimer(key).
  state.onSend = (key) => {
    state.sendingFiles[key].status = FileStatus.WaitingAccept;
    state.startWaitAcceptTimer(key);
  };

  // Mirrors the EVENT_RECEIVER_ACCEPT handler's entry point.
  state.onAccept = (key) => {
    state.clearWaitAcceptTimer(key);
    state.sendingFiles[key].status = FileStatus.Processing;
  };

  // Mirrors the EVENT_RECEIVER_REJECT / EVENT_VALIDATE_ERROR handlers.
  state.onReject = (key) => {
    state.clearWaitAcceptTimer(key);
    state.sendingFiles[key].error = new Error('Receiver reject the file');
    state.sendingFiles[key].status = FileStatus.Pending;
  };

  // Mirrors onRemove.
  state.onRemove = (key) => {
    state.clearWaitAcceptTimer(key);
    delete state.sendingFiles[key];
  };

  return state;
}

function addFile(state, key, name = 'a.bin') {
  state.sendingFiles[key] = {
    metaData: { name, size: 100, type: 'application/octet-stream', key: new Uint8Array() },
    progress: 0,
    bitrate: 0,
    stop: false,
    error: undefined,
    startTime: 0,
    status: FileStatus.Pending
  };
}

// ---- Test 1: timeout fires when the receiver never replies ----
{
  const state = newFixture();
  addFile(state, 'f1');
  state.onSend('f1');
  await delay(WAIT_ACCEPT_TIMEOUT * 3);

  const file = state.sendingFiles['f1'];
  assert.equal(file.status, FileStatus.Pending, 'timed-out file must return to Pending');
  assert.ok(file.error, 'timed-out file must carry an error');
  assert.match(file.error.message, /No response from receiver/, 'error must name the timeout');
  assert.deepEqual(
    state.toasts,
    [
      {
        message: `File a.bin failed: ${file.error.message}`,
        type: 'error'
      }
    ],
    'an error toast must fire exactly once'
  );
  assert.deepEqual(Object.keys(state.waitAcceptTimers), [], 'timer must be released after firing');
  console.log('ok - WaitingAccept times out back to Pending with error and toast');
}

// ---- Test 2: ACCEPT before the deadline cancels the timer ----
{
  const state = newFixture();
  addFile(state, 'f1');
  state.onSend('f1');
  await delay(WAIT_ACCEPT_TIMEOUT / 2);
  state.onAccept('f1');
  await delay(WAIT_ACCEPT_TIMEOUT * 2);

  const file = state.sendingFiles['f1'];
  assert.equal(file.status, FileStatus.Processing, 'accepted file must keep Processing');
  assert.equal(file.error, undefined, 'accepted file must not gain an error');
  assert.equal(state.toasts.length, 0, 'no toast when the receiver accepted in time');
  console.log('ok - accept within the timeout clears the timer');
}

// ---- Test 3: REJECT clears the timer (no spurious timeout toast) ----
{
  const state = newFixture();
  addFile(state, 'f1');
  state.onSend('f1');
  await delay(WAIT_ACCEPT_TIMEOUT / 2);
  state.onReject('f1');
  await delay(WAIT_ACCEPT_TIMEOUT * 2);

  const file = state.sendingFiles['f1'];
  assert.equal(file.status, FileStatus.Pending, 'rejected file must return to Pending');
  assert.match(file.error.message, /reject/, 'the error must be the rejection, not a timeout');
  assert.equal(
    state.toasts.length,
    0,
    'the fixture rejects silently; the timer must stay silent too'
  );
  console.log('ok - reject clears the timer so the timeout cannot double-fire');
}

// ---- Test 4: REMOVE clears the timer ----
{
  const state = newFixture();
  addFile(state, 'f1');
  state.onSend('f1');
  await delay(WAIT_ACCEPT_TIMEOUT / 2);
  state.onRemove('f1');
  await delay(WAIT_ACCEPT_TIMEOUT * 2);

  assert.equal(state.sendingFiles['f1'], undefined, 'removed file must be gone');
  assert.equal(state.toasts.length, 0, 'removing a WaitingAccept file must not fire a toast');
  assert.deepEqual(Object.keys(state.waitAcceptTimers), [], 'removal must release the timer');
  console.log('ok - remove clears the timer');
}

// ---- Test 5: resend restarts the timer instead of stacking ----
{
  const state = newFixture();
  addFile(state, 'f1');
  state.onSend('f1');
  await delay(WAIT_ACCEPT_TIMEOUT * 2); // first wait times out
  addFile(state, 'f1'); // user clicked Resend: error + Pending again
  state.onSend('f1');
  await delay(WAIT_ACCEPT_TIMEOUT * 3);

  const file = state.sendingFiles['f1'];
  assert.equal(file.status, FileStatus.Pending, 'second wait must time out too');
  assert.equal(
    state.toasts.filter((t) => /No response from receiver/.test(t.message)).length,
    2,
    'exactly one timeout toast per send attempt — no stacked timers'
  );
  console.log('ok - resending restarts the timer without stacking');
}

// ---- Test 6: channel close fails every WaitingAccept file, leaves others ----
{
  const state = newFixture();
  addFile(state, 'f1', 'one.bin');
  addFile(state, 'f2', 'two.bin');
  state.onSend('f1');
  state.onSend('f2');
  await delay(WAIT_ACCEPT_TIMEOUT / 2);
  state.onAccept('f1'); // f1 already accepted; f2 still waiting
  state.onChannelClose();

  const f1 = state.sendingFiles['f1'];
  const f2 = state.sendingFiles['f2'];
  assert.equal(f1.status, FileStatus.Processing, 'accepted file must survive the close');
  assert.equal(f1.error, undefined, 'accepted file must not gain an error');
  assert.equal(f2.status, FileStatus.Pending, 'waiting file must return to Pending');
  assert.match(
    f2.error.message,
    /Disconnected from receiver/,
    'close error must name the disconnect'
  );
  assert.deepEqual(
    state.toasts,
    [{ message: 'File two.bin failed: Disconnected from receiver', type: 'error' }],
    'only the still-waiting file gets a toast'
  );
  assert.deepEqual(Object.keys(state.waitAcceptTimers), [], 'close must release every timer');
  console.log('ok - channel close fails only the still-waiting files');
}

// ---- Test 7: the fix is actually wired into the component (static guard) ----
{
  const senderSource = readFileSync(
    join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
    'utf8'
  );
  const configsSource = readFileSync(join(here, '..', 'src', 'configs.ts'), 'utf8');

  assert.ok(
    /export const WAIT_ACCEPT_TIMEOUT = \d+/.test(configsSource),
    'configs.ts must export WAIT_ACCEPT_TIMEOUT'
  );
  assert.ok(
    /WAIT_ACCEPT_TIMEOUT/.test(senderSource),
    'Sender.svelte must use the WAIT_ACCEPT_TIMEOUT constant'
  );
  assert.ok(
    /status = FileStatus\.WaitingAccept;\s*\n\s*startWaitAcceptTimer\(key\)/.test(senderSource),
    'onSend must start the timer immediately after entering WaitingAccept'
  );
  assert.match(
    senderSource,
    /clearWaitAcceptTimer\(key\);\s*\n\s*sendingFiles\[key\]\.status = FileStatus\.Processing/,
    'the ACCEPT handler must clear the timer before moving to Processing'
  );
  assert.ok(
    (senderSource.match(/clearWaitAcceptTimer\(key\);/g) || []).length >= 5,
    'accept, reject, validate-error and onRemove must each clear the timer'
  );
  assert.ok(
    /export function onChannelClose\(\)/.test(senderSource),
    'Sender.svelte must export onChannelClose for the page-level disconnect guard'
  );
  console.log(
    'ok - Sender.svelte wires the WAIT_ACCEPT_TIMEOUT timer with cleanup on every exit path'
  );
}

// ---- Test 8: both pages call onChannelClose on dataChannel.onclose ----
{
  for (const page of ['ReceivePage.svelte', 'OfferPage.svelte']) {
    const source = readFileSync(join(here, '..', 'src', 'components', page), 'utf8');
    assert.ok(
      /dataChannel\.onclose = \(\) => \{[\s\S]*?sender\?\.onChannelClose\(\);[\s\S]*?\};/.test(
        source
      ),
      `${page} must call sender?.onChannelClose() in its dataChannel.onclose handler`
    );
  }
  console.log('ok - OfferPage and ReceivePage wire dataChannel.onclose to sender.onChannelClose');
}

console.log(
  'ok - sender waiting-accept: timeout and disconnect handling fail stuck files back to Pending'
);
