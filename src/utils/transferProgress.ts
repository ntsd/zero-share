// Shared per-file progress + bitrate UI-update, deduplicated from the two
// copy-pasted blocks in Sender.svelte (sendNextChunk) and Receiver.svelte
// (processChunk) — the same failure class as the guarded data-channel send
// (src/utils/channelSender.ts) and the data-channel onmessage handler
// (src/utils/peerMessage.ts): any future hardening of the progress/bitrate
// semantics (the #134 zero-elapsed floor, a different UI step, a moving-window
// bitrate) must now land in exactly one place instead of two call sites that
// must stay byte-identical.
//
// The helper is pure math + state writes only: no toasts, no channel sends.
// The surrounding pipeline (chunk slicing, acks, blob-on-complete, reject
// paths) stays in the components.

import { PROGRESS_UPDATE_UI_STEP } from '../configs';

// Per-file transfer bookkeeping (non-UI). `startTime` is the attempt's
// accept-time clock — the ONLY clock the bitrate denominator may read (see
// tests/sender-bitrate-clock.test.mjs). `progress` is the throttled
// percentage; `nextProgressUpdate` is the next threshold the UI update
// fires at.
export interface TransferStats {
  progress: number;
  startTime: number;
  nextProgressUpdate: number;
}

// The UI entry the updated values are written to ($state the card renders
// from). Both fields are written only on a progress-update tick, so a
// structural type is all the helper needs.
export interface TransferProgressTarget {
  progress?: number;
  bitrate?: number;
}

// Advance the per-file progress bookkeeping and, when the nextProgressUpdate
// threshold is crossed, push progress + bitrate into the UI entry.
//
//   - progress = clamp(round(sentBytes / totalBytes * 100), 0, 100) with a
//     NaN -> 0 fallback: uniform for both sides. The sender's sentBytes never
//     overshoots its own slice bookkeeping, so its ratio is naturally <= 100
//     and the clamp is inert there; for the receiver it is defense in depth
//     against a peer that claims a size smaller than the payload it actually
//     streams (the exact-match completion gate in processChunk still rejects
//     that stream — the clamp only keeps the UI value renderable until it
//     does).
//   - bitrate = sentBytes / elapsed, where elapsed is time-since-ACCEPT
//     (stats.startTime) floored to a 1 ms minimum: a small file whose accept
//     and first progress update share a millisecond makes the raw denominator
//     0, and bytes / 0 is Infinity (or NaN) — a value that would be stored in
//     $state and render as a misleading "0 B/sec".
//   - nextProgressUpdate advances by PROGRESS_UPDATE_UI_STEP, clamped to 100.
export function updateTransferProgress(
  stats: TransferStats,
  sentBytes: number,
  totalBytes: number,
  writeTo: TransferProgressTarget
): void {
  const rawProgress = Math.round((sentBytes / totalBytes) * 100);
  stats.progress = Math.min(100, Math.max(0, Number.isNaN(rawProgress) ? 0 : rawProgress));
  if (stats.progress >= stats.nextProgressUpdate) {
    // update UI
    writeTo.progress = stats.progress;
    // calculate bitrate and update UI
    const elapsedMs = Math.max(1, Date.now() - stats.startTime);
    writeTo.bitrate = Math.round(sentBytes / (elapsedMs / 1000));
    // schedule next update
    stats.nextProgressUpdate += PROGRESS_UPDATE_UI_STEP;
    if (stats.nextProgressUpdate > 100) {
      stats.nextProgressUpdate = 100;
    }
  }
}
