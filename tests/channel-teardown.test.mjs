// Regression guard for the dedup of the data-channel death teardown: the
// identical ~18-line onerror/onclose block (error/close toast, isConnecting
// reset, offer-link clear on the offer page, sender/receiver
// onChannelClose() propagation, guarded connection.close()) was
// copy-pasted into OfferPage.svelte and ReceivePage.svelte — the same
// failure class this board already deduped for the guarded-send
// (src/utils/channelSender.ts) and the onmessage handler
// (src/utils/peerMessage.ts). Any future hardening of the channel-death
// semantics (a toast dedup, an error-state marker, a before-unload flush)
// must now land in exactly one place: src/utils/channelTeardown.ts.
//
// Two halves (matching tests/channel-sender.test.mjs):
//   1. The helper, exercised directly under Node: the error handler toasts
//      'WebRTC error' (error status), the close handler toasts
//      'Disconnected'; both reset the connection state, run the optional
//      lost hook, propagate onChannelClose() into BOTH pipelines, and
//      release the peer with the guarded shape — no InvalidStateError on a
//      double-fire (error then close), and the peer getter reads the
//      CURRENT peer at fire time (the offer-page regeneration case).
//   2. Static source guards: BOTH pages wire dataChannel.onerror/onclose
//      through the shared helper, and neither still carries its own copy of
//      the teardown body (toast strings, guarded close, inline
//      onChannelClose() calls).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');

// Transpile src/**.ts to a temp tree (same relative path, .js) and import
// it. The source's relative import specifiers carry no extension, which
// Node ESM rejects — rewrite them to the .js siblings (same convention as
// tests/peer-message-handler.test.mjs).
const tmpRoot = join(here, '.channel-teardown.tmp');
async function loadTranspiled(name) {
  const source = readFileSync(join(here, '..', 'src', name), 'utf8');
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

const { toastAtom } = await loadTranspiled('stores/toastStore.ts');
const { createChannelTeardown } = await loadTranspiled('utils/channelTeardown.ts');

// ---- Mocks -------------------------------------------------------------
// Mock RTCPeerConnection: close() throws the real InvalidStateError the
// platform raises when a second close() lands on a settled 'closed' peer.
function makePeer() {
  const peer = {
    connectionState: 'connected',
    closeCalls: 0,
    close() {
      if (this.connectionState === 'closed') {
        throw new DOMException('Peer is already closed', 'InvalidStateError');
      }
      this.connectionState = 'closed';
      this.closeCalls++;
    }
  };
  return peer;
}

// Fresh wiring per scenario, with a recording pipeline. The shared toast
// atom is reset up front so each scenario's subscription starts clean
// (subscribing fires the current value immediately — a previous
// scenario's toast would otherwise leak into the count).
function makeWiring() {
  toastAtom.set(null);
  const calls = [];
  const sender = {
    onChannelClose() {
      calls.push('sender');
    }
  };
  const receiver = {
    onChannelClose() {
      calls.push('receiver');
    }
  };
  let peer = makePeer();
  const toasts = [];
  const unsub = toastAtom.subscribe((t) => {
    if (t !== null) toasts.push(t);
  });
  return {
    calls,
    toasts,
    unsub,
    teardown: createChannelTeardown({
      getConnection: () => peer,
      getSender: () => sender,
      getReceiver: () => receiver,
      markNotConnecting: () => {
        calls.push('notConnecting');
      },
      onChannelLost: () => {
        calls.push('lost');
      }
    }),
    setPeer(p) {
      peer = p;
    }
  };
}

// ---- Test 1: the error handler's full teardown sequence ----
{
  const w = makeWiring();
  const peer = makePeer();
  w.setPeer(peer);
  w.teardown.onerror();
  assert.equal(w.toasts.length, 1, 'onerror must surface exactly one toast');
  assert.equal(w.toasts[0].message, 'WebRTC error', 'onerror toasts "WebRTC error"');
  assert.equal(w.toasts[0].status, 'error', 'onerror toasts with error status');
  assert.deepEqual(
    w.calls,
    ['notConnecting', 'lost', 'sender', 'receiver'],
    'onerror must reset the connection state, run the lost hook, THEN propagate into both pipelines (order: state reset before hook, hook before pipeline propagation)'
  );
  assert.equal(peer.closeCalls, 1, 'onerror must release the live peer exactly once');
  assert.equal(peer.connectionState, 'closed');
  w.unsub();
  console.log(
    'ok - onerror: WebRTC error toast, state reset, lost hook, both pipelines, guarded peer close'
  );
}

// ---- Test 2: the close handler's full teardown sequence ----
{
  const w = makeWiring();
  const peer = makePeer();
  w.setPeer(peer);
  w.teardown.onclose();
  assert.equal(w.toasts.length, 1, 'onclose must surface exactly one toast');
  assert.equal(w.toasts[0].message, 'Disconnected', 'onclose toasts "Disconnected"');
  assert.equal(w.toasts[0].status, 'error', 'onclose toasts with error status');
  assert.deepEqual(
    w.calls,
    ['notConnecting', 'lost', 'sender', 'receiver'],
    'onclose must reset the connection state, run the lost hook, THEN propagate into both pipelines'
  );
  assert.equal(peer.closeCalls, 1, 'onclose must release the live peer exactly once');
  w.unsub();
  console.log(
    'ok - onclose: Disconnected toast, state reset, lost hook, both pipelines, guarded peer close'
  );
}

// ---- Test 3: double-fire safety — error then close must not throw ----
// close() throws InvalidStateError on an already-closed peer: the second
// fire must see the settled 'closed' state through the guard and no-op the
// release (the original P0 guard, pinned here so a reformat of the helper
// that drops the guard cannot land).
{
  const w = makeWiring();
  const peer = makePeer();
  w.setPeer(peer);
  w.teardown.onerror();
  assert.doesNotThrow(() => w.teardown.onclose(), 'error-then-close double-fire must not throw');
  assert.equal(
    peer.closeCalls,
    1,
    'the second fire must see the settled closed state and skip the release'
  );
  w.unsub();
  console.log('ok - error+close double-fire: no InvalidStateError, single release');
}

// ---- Test 4: the peer getter reads the CURRENT peer at fire time ----
// OfferPage reassigns `connection` to a new peer on every "Generate
// Offer": a handler that somehow survived the regeneration race must close
// the peer that actually owns the dying generation, not a captured first
// peer. The getter must therefore be consulted at fire time.
{
  const w = makeWiring();
  const oldPeer = makePeer();
  const newPeer = makePeer();
  w.setPeer(oldPeer);
  // The regeneration swapped the peer AFTER the handler was wired.
  w.setPeer(newPeer);
  w.teardown.onclose();
  assert.equal(newPeer.closeCalls, 1, 'the teardown must close the CURRENT peer at fire time');
  assert.equal(newPeer.connectionState, 'closed');
  assert.equal(oldPeer.closeCalls, 0, 'a captured/stale first peer must not be touched');
  w.unsub();
  console.log(
    'ok - the peer getter reads the current RTCPeerConnection at fire time (no stale capture)'
  );
}

// ---- Test 5: no lost hook on the receive page — the sequence minus the hook ----
{
  toastAtom.set(null);
  const calls = [];
  const toasts = [];
  const unsub = toastAtom.subscribe((t) => {
    if (t !== null) toasts.push(t);
  });
  const peer = makePeer();
  const teardown = createChannelTeardown({
    getConnection: () => peer,
    getSender: () => ({ onChannelClose() {} }),
    getReceiver: () => ({ onChannelClose() {} }),
    markNotConnecting: () => {
      calls.push('notConnecting');
    }
    // no onChannelLost — ReceivePage has no offer link to clear
  });
  teardown.onclose();
  assert.equal(calls.length, 1, 'without a lost hook the state reset still runs');
  assert.equal(calls[0], 'notConnecting');
  assert.equal(toasts.length, 1, 'the toast still fires without the hook');
  assert.equal(peer.closeCalls, 1);
  unsub();
  console.log('ok - an omitted onChannelLost hook is safe (receive-page shape)');
}

// ---- Test 6: a missing peer is skipped without error ----
{
  toastAtom.set(null);
  const toasts = [];
  const unsub = toastAtom.subscribe((t) => {
    if (t !== null) toasts.push(t);
  });
  const teardown = createChannelTeardown({
    getConnection: () => undefined,
    getSender: () => undefined,
    getReceiver: () => undefined,
    markNotConnecting: () => {}
  });
  assert.doesNotThrow(() => teardown.onclose(), 'a missing peer must not throw');
  assert.equal(toasts.length, 1, 'the toast still fires when the peer is missing');
  unsub();
  console.log('ok - a missing RTCPeerConnection is skipped without error');
}

// ---- Static guards: both pages delegate, no copy-paste remains ----
const offerSource = readFileSync(join(here, '..', 'src', 'components', 'OfferPage.svelte'), 'utf8');
const receiveSource = readFileSync(
  join(here, '..', 'src', 'components', 'ReceivePage.svelte'),
  'utf8'
);
for (const [name, source] of [
  ['OfferPage.svelte', offerSource],
  ['ReceivePage.svelte', receiveSource]
]) {
  assert.ok(
    source.includes("import { createChannelTeardown } from '../utils/channelTeardown';"),
    `${name} must import the shared teardown helper`
  );
  assert.ok(
    /createChannelTeardown\(/.test(source),
    `${name} must build the teardown via createChannelTeardown(...)`
  );
  for (const handler of ['onclose', 'onerror']) {
    const assignIdx = source.indexOf(`dataChannel.${handler} = `);
    assert.ok(assignIdx !== -1, `${name}: dataChannel.${handler} must still be wired`);
    const rest = source.slice(assignIdx, assignIdx + 120);
    assert.ok(
      /channelTeardown\./.test(rest),
      `${name}: dataChannel.${handler} must delegate to the shared teardown`
    );
  }
  // The deduped copies are GONE from the pages: no page-local toast
  // strings, no guarded connection.close() inside a death handler, no
  // inline pipeline-propagation calls.
  for (const toast of ["'WebRTC error'", "'Disconnected'"]) {
    assert.ok(!source.includes(toast), `${name}: the ${toast} toast belongs to the helper`);
  }
  // The death WIRING (the dataChannel.onerror / dataChannel.onclose
  // assignments) must carry no inline connection.close(): the guarded
  // release lives exactly once, in the helper. (OfferPage still owns two
  // LEGITIMATE page-local guarded closes — the "Generate Offer"
  // regeneration teardown and the offer-creation failure handler — so the
  // check is scoped to the death-handler wiring, not the whole page.)
  const wiringStart = source.indexOf('dataChannel.onerror = ');
  const wiringEnd = source.indexOf('dataChannel.onclose = ', wiringStart);
  assert.ok(
    wiringStart !== -1 && wiringEnd > wiringStart,
    `${name}: dataChannel.onerror and dataChannel.onclose must be wired`
  );
  const deathWiring = source.slice(wiringStart, source.indexOf(';', wiringEnd) + 1);
  assert.ok(
    !deathWiring.includes('connection.close'),
    `${name}: the dataChannel.onclose/onerror wiring must delegate to the shared teardown and carry no inline connection.close()`
  );
  assert.equal(
    (source.match(/sender\?\.onChannelClose\(\);/g) || []).length,
    0,
    `${name}: the inline sender?.onChannelClose() copies are gone (propagation lives in the helper)`
  );
  assert.equal(
    (source.match(/receiver\?\.onChannelClose\(\);/g) || []).length,
    0,
    `${name}: the inline receiver?.onChannelClose() copies are gone (propagation lives in the helper)`
  );
  // OfferPage is the only page with the link-clear hook; it must still clear
  // the dead generation's offer link through it.
  if (name === 'OfferPage.svelte') {
    assert.ok(
      /onChannelLost\s*:\s*\(\)\s*=>\s*\{\s*offerLink\s*=\s*''/.test(source),
      "OfferPage must clear the dead generation's offer link via the onChannelLost hook"
    );
  } else {
    // The ReceivePage constraint is about the OPTIONS passed to
    // createChannelTeardown — not the whole source (a comment mentioning the
    // hook must not fail the page). Brace-match the options object, the way
    // tests/dead-channel-peer-close.test.mjs does.
    const createIdx = source.search(/createChannelTeardown\(/);
    assert.ok(createIdx !== -1, 'ReceivePage must call createChannelTeardown(...)');
    const braceStart = source.indexOf('{', createIdx);
    let depth = 0;
    let options = '';
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          options = source.slice(braceStart, i + 1);
          break;
        }
      }
    }
    assert.ok(
      !options.includes('onChannelLost'),
      'ReceivePage must not pass an onChannelLost hook (it has no offer link)'
    );
  }
}

const teardownSource = readFileSync(join(here, '..', 'src', 'utils', 'channelTeardown.ts'), 'utf8');
assert.ok(
  teardownSource.includes("'WebRTC error'") && teardownSource.includes("'Disconnected'"),
  'the helper owns both channel-death toast strings'
);
assert.ok(
  /connectionState\s*!==\s*['"]closed['"]/.test(teardownSource),
  'the helper keeps the guarded release shape'
);
assert.ok(
  teardownSource.includes('getSender()?.onChannelClose();') &&
    teardownSource.includes('getReceiver()?.onChannelClose();'),
  'the helper owns the onChannelClose() pipeline propagation'
);

// ---- cleanup: drop the transpiled temp tree ----
await rm(tmpRoot, { recursive: true, force: true });

console.log(
  'ok - channel teardown dedup: both pages route channel death through the shared helper, behavior pinned'
);
