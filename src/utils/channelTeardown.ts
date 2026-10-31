// Shared data-channel death teardown, deduplicated from the two ~18-line
// copy-pasted blocks that lived in OfferPage.svelte and ReceivePage.svelte —
// the same failure class as the guarded-send dedup
// (src/utils/channelSender.ts) and the onmessage dedup
// (src/utils/peerMessage.ts): every "connection lost" hardening since the
// guarded-send (#97) and onmessage (#71) dedups had to be applied to BOTH
// pages in lockstep, and a future hardening landing on only one page
// silently desyncs peer behavior.
//
// When the data channel dies (peer closed the tab, dropped the network, a
// channel error, or a "Generate Offer" regeneration closed it) the channel
// will never deliver again. This helper is the single place that:
//   1. surfaces the toast ('WebRTC error' on error, 'Disconnected' on close),
//   2. marks the page as no longer connecting,
//   3. runs the page-specific lost hook (`onChannelLost`, e.g. OfferPage
//      clearing its dead offer link),
//   4. propagates "connection lost" into BOTH file pipelines via
//      sender/receiver onChannelClose() — in-flight/queued work exits with
//      an accurate error instead of dead-ending or re-firing false
//      per-chunk errors,
//   5. releases the RTCPeerConnection with the guarded shape
//        if (connection && connection.connectionState !== 'closed') {
//          connection.close();
//        }
//      because closing the data channel does NOT close the peer: without
//      this, the ICE agent, its UDP sockets, and the STUN/TURN keepalives
//      stay open for the rest of the page's lifetime. The guard is
//      required because close() throws InvalidStateError on an
//      already-closed peer (error+close double-fire, or a regeneration
//      that raced this handler).
//
// The peer getter must read the CURRENT RTCPeerConnection at fire time,
// not a captured one: the offer page reassigns its `connection` to a new
// peer on every "Generate Offer" regeneration, so a handler that somehow
// survives a regeneration race must close the peer that actually owns the
// dying generation. (ReceivePage's `connection` is a const, so a plain
// getter covers it too.)
import { addToastMessage } from '../stores/toastStore';

export interface ChannelTeardownOptions {
  // Live read of the RTCPeerConnection this channel belongs to (must not be
  // captured at wiring time — see the module comment).
  getConnection: () => RTCPeerConnection | undefined;
  // Live read of the page's Sender component ref (undefined until the
  // transfer section renders the Sender for the live channel).
  getSender: () => { onChannelClose(): void } | undefined;
  // Live read of the page's Receiver component ref.
  getReceiver: () => { onChannelClose(): void } | undefined;
  // Reset the page's "connected" UI state (isConnecting = false).
  markNotConnecting: () => void;
  // Page-specific lost hook, run after the toast/state reset and before the
  // pipeline propagation. OfferPage passes `() => { offerLink = ''; }` to
  // clear the dead generation's link; ReceivePage has no link to clear.
  onChannelLost?: () => void;
}

export interface ChannelTeardown {
  // Assign to dataChannel.onerror.
  onerror: () => void;
  // Assign to dataChannel.onclose.
  onclose: () => void;
}

export function createChannelTeardown({
  getConnection,
  getSender,
  getReceiver,
  markNotConnecting,
  onChannelLost
}: ChannelTeardownOptions): ChannelTeardown {
  function teardown(toast: string): void {
    addToastMessage(toast, 'error');
    // The channel will never deliver again: stop reporting the connection
    // as live (the transfer section keys off isConnecting).
    markNotConnecting();
    onChannelLost?.();
    // A failed/closed channel never recovers: propagate "connection lost"
    // into the file pipelines on BOTH sides so in-flight files stop their
    // pipelines with an accurate error instead of staying in Processing
    // forever while queued chunks re-fire corrupt-chunk toasts.
    getSender()?.onChannelClose();
    getReceiver()?.onChannelClose();
    // Release the WebRTC peer with the channel: closing the data channel
    // alone leaves the RTCPeerConnection (ICE agent, UDP sockets,
    // STUN/TURN keepalives) live until the browser's ICE timeout or page
    // unload. Guarded on connectionState because close() throws
    // InvalidStateError on an already-closed peer (error+close
    // double-fire, or a racing regeneration).
    const connection = getConnection();
    if (connection && connection.connectionState !== 'closed') {
      connection.close();
    }
  }

  return {
    onerror: () => teardown('WebRTC error'),
    onclose: () => teardown('Disconnected')
  };
}
