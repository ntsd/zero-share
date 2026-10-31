// Regression guard for P1 "Sending: X/sec" under-reporting the real
// throughput after any waiting-accept delay:
//
//   onSend() creates the closure's fileStats with `startTime: Date.now()`
//   at the Send CLICK. The entry then sits in FileStatus.WaitingAccept
//   until the peer's ACCEPT event arrives, and the chunk pipeline only
//   starts on accept. The progress update computed the bitrate as
//   `offset / ((Date.now() - fileStats.startTime) / 1000)` — i.e. bytes
//   sent divided by time-since-Send-click. Any wait between Send and
//   Accept (e.g. receiver with Auto accept = Off) inflated the
//   denominator, so the card showed ~240 KB/s for a file actually
//   streaming at 10 MB/s.
//
// The fix (src/components/sender/Sender.svelte): the
// EVENT_RECEIVER_ACCEPT handler resets the closure clock
// `fileStats.startTime = Date.now();` next to the existing entry-level
// `f.startTime = Date.now();` write, so the bitrate denominator is
// time-since-ACCEPT — mirroring the receiver, which starts
// receivingFiles[id].startTime in onAccept() and computes its
// "Receiving: X/sec" bitrate from it. No wire-protocol, chunking, or
// progress-throttle change: progress is an offset/size ratio and is
// unaffected.
//
// This test is static source inspection: Node cannot mount Svelte DOM
// components, so it reads src/components/sender/Sender.svelte and
// asserts the fix shape, mirroring tests/drag-drop-paste.test.mjs and
// tests/sender-stop-final-ack.test.mjs.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const senderSource = readFileSync(
  join(here, '..', 'src', 'components', 'sender', 'Sender.svelte'),
  'utf8'
);
const receiverSource = readFileSync(
  join(here, '..', 'src', 'components', 'receiver', 'Receiver.svelte'),
  'utf8'
);

// ---- Helper: find the body of the EVENT_RECEIVER_ACCEPT listener ----
// The handler is registered as
// `sendingFile.event?.on(receiveEventToJSON(ReceiveEvent.EVENT_RECEIVER_ACCEPT), async () => { ... });`
// so the body is the arrow-function block following that registration.
function extractAcceptHandler(source) {
  const reg = source.search(
    /receiveEventToJSON\(\s*ReceiveEvent\.EVENT_RECEIVER_ACCEPT\s*\)\s*,\s*async\s*\(\s*\)\s*=>\s*\{/
  );
  assert.ok(reg !== -1, 'the EVENT_RECEIVER_ACCEPT listener must exist in Sender.svelte');
  const braceStart = source.indexOf('{', reg);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new assert.AssertionError({ message: 'EVENT_RECEIVER_ACCEPT handler: unbalanced braces' });
}

// ---- Test 1: the ACCEPT handler resets the closure bitrate clock ----
{
  const body = extractAcceptHandler(senderSource);

  // The handler must still establish the processing state …
  assert.ok(
    /f\.status\s*=\s*FileStatus\.Processing;/.test(body),
    'the ACCEPT handler must set the entry to FileStatus.Processing'
  );
  // … keep the entry-level clock reset …
  assert.ok(
    /f\.startTime\s*=\s*Date\.now\(\);/.test(body),
    'the ACCEPT handler must reset the entry-level f.startTime (kept)'
  );
  // … AND reset the closure clock that the bitrate denominator reads.
  // Without this, the denominator stays time-since-Send-click and any
  // waiting-accept delay under-reports the displayed throughput.
  assert.ok(
    /fileStats\.startTime\s*=\s*Date\.now\(\);/.test(body),
    'the ACCEPT handler must reset fileStats.startTime (the bitrate denominator clock)'
  );

  // Both clock resets must happen BEFORE the chunk pipeline starts: the
  // first sendNextChunk() call is what begins byte delivery, so a reset
  // after it would let the first chunk's progress update use a stale
  // denominator.
  const pipelineStart = body.search(/await\s+sendNextChunk\s*\(\s*\)/);
  assert.ok(pipelineStart !== -1, 'the ACCEPT handler must start the chunk pipeline');
  const closureResetIdx = body.search(/fileStats\.startTime\s*=\s*Date\.now\(\);/);
  assert.ok(
    closureResetIdx !== -1 && closureResetIdx < pipelineStart,
    'fileStats.startTime must be reset before the first sendNextChunk() call'
  );

  // Exactly one reset of the closure clock: a second reset later in the
  // same handler (or elsewhere) would restart the clock mid-transfer and
  // re-inflate the denominator on the next progress tick.
  assert.equal(
    (body.match(/fileStats\.startTime\s*=\s*Date\.now\(\);/g) || []).length,
    1,
    'the ACCEPT handler must reset fileStats.startTime exactly once'
  );

  console.log('ok - sender: the ACCEPT handler resets the closure bitrate clock');
}

// ---- Test 2: the bitrate expression divides by the closure clock ----
{
  // The progress update must still compute the bitrate as bytes-sent /
  // elapsed-time, and the elapsed time must come from fileStats.startTime
  // (the clock reset at accept), not f.startTime (entry-level, vestigial
  // on the sender side) nor any other clock.
  // The elapsed term is floored to a 1 ms minimum (const elapsedMs =
  // Math.max(1, ...)) before the division: a same-millisecond accept +
  // first progress update would otherwise divide by 0 and store
  // Infinity/NaN in $state. The guard shape is pinned by
  // tests/bitrate-zero-elapsed-guard.test.mjs; this test keeps pinning
  // the CLOCK the guard must not touch.
  assert.ok(
    /const\s+elapsedMs\s*=\s*Math\.max\(\s*1\s*,\s*Date\.now\(\)\s*-\s*fileStats\.startTime\s*\)/.test(
      senderSource
    ),
    'the elapsed-time denominator must be derived from fileStats.startTime (the accept-time clock)'
  );
  assert.ok(
    /sendingFile\.bitrate\s*=\s*Math\.round\(\s*offset\s*\/\s*\(\s*elapsedMs\s*\/\s*1000\s*\)/.test(
      senderSource
    ),
    'the bitrate must divide offset by the floored elapsed time'
  );
  // The pre-fix / buggy shape — a denominator derived from the entry
  // clock — must not exist anywhere on the sender side.
  assert.ok(
    !/bitrate\s*=.*(?:f\.startTime|sendingFile\.startTime)/.test(senderSource),
    'the sender bitrate must not be derived from the entry-level startTime'
  );

  // The progress throttle itself is out of scope for the fix and must be
  // untouched: progress stays an offset/size ratio on the same
  // nextProgressUpdate schedule.
  assert.ok(
    /fileStats\.progress\s*=\s*Math\.round\(\s*\(\s*offset\s*\/\s*sendingFile\.metaData\.size\s*\)\s*\*\s*100\s*\)/.test(
      senderSource
    ),
    'progress must stay an offset/size ratio (unchanged by the bitrate fix)'
  );
  assert.ok(
    /fileStats\.nextProgressUpdate\s*\+=\s*PROGRESS_UPDATE_UI_STEP;/.test(senderSource),
    'the progress throttle step must be unchanged'
  );

  console.log('ok - sender: the bitrate expression uses the closure clock, throttle intact');
}

// ---- Test 3: a Resend gets a clean clock (fresh fileStats per onSend) ----
{
  // onSend() creates the closure per call — the clock that starts at the
  // (re)Send click must be local to that call, so a Resend never inherits
  // a stale denominator from the previous attempt.
  const onSendIdx = senderSource.search(/async\s+function\s+onSend\s*\(/);
  assert.ok(onSendIdx !== -1, 'onSend() must exist');
  const onSendEnd = senderSource.search(/async\s+function\s+sendAllFiles\s*\(/);
  const onSendBody = senderSource.slice(onSendIdx, onSendEnd > -1 ? onSendEnd : undefined);
  assert.ok(
    /const\s+fileStats\s*:\s*FileStats\s*=\s*[\s\S]*?startTime\s*:\s*Date\.now\(\)[\s\S]*?nextProgressUpdate\s*:\s*0/.test(
      onSendBody
    ),
    'onSend() must create a fresh fileStats (clean clock) per call'
  );

  console.log('ok - sender: a Resend gets a fresh fileStats clock');
}

// ---- Test 4: the receiver's symmetric path is untouched and correct ----
{
  // The receiver already starts its entry clock in onAccept() and
  // computes "Receiving: X/sec" from it — this guard pins the symmetry so
  // the sender fix cannot drift away from the established semantics.
  // The denominator is a floored const (see
  // tests/bitrate-zero-elapsed-guard.test.mjs); the clock it derives
  // from must still be receivingFiles[id].startTime (time-since-accept).
  assert.ok(
    /receivingFile\.startTime\s*=\s*Date\.now\(\);/.test(receiverSource),
    'the receiver must keep starting its entry clock at ACCEPT time'
  );
  assert.ok(
    /const\s+elapsedMs\s*=\s*Math\.max\(\s*1\s*,\s*Date\.now\(\)\s*-\s*receivingFiles\[id\]\.startTime\s*\)/.test(
      receiverSource
    ),
    'the receiver elapsed time must stay derived from receivingFiles[id].startTime (time-since-accept)'
  );
  assert.ok(
    /receivingFiles\[id\]\.bitrate\s*=\s*Math\.round\(\s*receivingFileStatsMap\[id\]\.receivedSize\s*\/\s*\(\s*elapsedMs\s*\/\s*1000\s*\)/.test(
      receiverSource
    ),
    'the receiver bitrate must keep dividing received bytes by the time-since-accept elapsed time'
  );

  console.log('ok - receiver: symmetric accept-time clock semantics intact');
}

console.log(
  'ok - sender bitrate clock: denominator is time-since-ACCEPT, not time-since-Send-click'
);
