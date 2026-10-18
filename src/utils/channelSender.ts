// Shared guarded data-channel send, deduplicated from the two identical
// copies that lived in Sender.svelte and Receiver.svelte — the same failure
// class as the data-channel onmessage handler dedup
// (src/utils/peerMessage.ts): any future hardening of the guarded-send
// semantics (close-timing races, backpressure, error surfacing) lands here
// once instead of in two places that must stay in sync.
//
// The lost flag is flipped by the owning component's onChannelClose()
// (fired from the page's dataChannel onclose/onerror) via markLost(), or by
// send() when a send throws. Once true the channel will never deliver
// anything again, so in-flight/queued chunk pipelines must exit quietly
// instead of surfacing misleading per-chunk errors.
//
// Guarded channel send: readyState first, and a closed/closing channel that
// slips past the check (the close settles asynchronously) is caught here
// instead of escaping as an InvalidStateError — the pre-fix failure mode,
// where a dead channel read as "Failed to send chunk: InvalidStateError..."
// or "Failed to encode file metadata" while the real cause was connection
// loss.
export interface ChannelSender {
  // Guarded send: false without touching the channel when the flag is set or
  // readyState !== 'open'; true on a successful send; on a throwing send the
  // flag is flipped and false is returned.
  send(message: Uint8Array): boolean;
  // Live read of the lost flag (the components' onChannelClose() early-out
  // and the sender's UI gate derive from this).
  isLost(): boolean;
  // Idempotent flip used by onChannelClose(): safe to call when the flag is
  // already set (a throwing send() may have won the race).
  markLost(): void;
}

export function createChannelSender(dataChannel: RTCDataChannel): ChannelSender {
  let lost = false;
  return {
    send(message: Uint8Array): boolean {
      if (lost || dataChannel.readyState !== 'open') {
        return false;
      }
      try {
        dataChannel.send(message as Uint8Array<ArrayBuffer>);
        return true;
      } catch {
        lost = true;
        return false;
      }
    },
    isLost() {
      return lost;
    },
    markLost() {
      lost = true;
    }
  };
}
