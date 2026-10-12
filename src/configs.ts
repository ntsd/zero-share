import type { ReceiveOptions, SendOptions } from './type';

// Shared predicate for ICE-server values: accepts the known STUN allowlist
// below plus any well-formed `stun:`/`turn:` URL the user types in the
// sender's custom field. Enforced on BOTH the sender (OfferPage — what may be
// emitted into the `i` link param) and the receiver (ReceivePage — what may
// be accepted from it), so a value the sender encodes is always honored by
// the peer; asymmetric ICE servers silently break NAT traversal / TURN relay.
export function isSupportedIceServer(server: string | undefined | null): server is string {
  // A well-formed ICE URL: stun:/stuns:/turn:/turns: scheme, a host (ASCII
  // hostname or bracketed IPv6), optional port, and an optional `?`/`#` query
  // carrying e.g. the TURN transport/username/password. Any whitespace makes
  // the value malformed, so it is rejected on both sides.
  return (
    typeof server === 'string' &&
    /^(stun|turn)s?:([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\])(?::[0-9]{1,5})?(?:[?#][^\s]*)?$/i.test(
      server
    )
  );
}

export const STUN_SERVERS: string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun.l.google.com:19305',
  'stun:stun4.l.google.com:19302',
  'stun:stun4.l.google.com:19305',
  'stun:stun.sipgate.net:3478',
  'stun:stun.sipgate.net:10000',
  // The Nextcloud STUN relay listens on https; it is served over TLS and has
  // no `stun:` alias, so it needs the `stuns:` scheme to be a valid ICE URL.
  'stuns:stun.nextcloud.com:3478',
  'stuns:stun.nextcloud.com:443',
  'stun:stun.myvoipapp.com:3478',
  'stun:stun.voipstunt.com:3478'
];

export const PAGE_DESCRIPTION = 'A client-side secure P2P file sharing using WebRTC.';

export const GITHUB_LINK = 'https://github.com/ntsd/zero-share';

export const DEFAULT_SEND_OPTIONS: SendOptions = {
  chunkSize: 32 * 1024, // 32KB
  isEncrypt: false,
  iceServer: STUN_SERVERS[0]
};

// Effective ICE server for a chosen value: honors it when it passes the
// shared predicate, otherwise the default. Both the sender (what it configures
// its RTCPeerConnection with and what it emits into the `i` link param) and
// the receiver (what it accepts from the `i` param) resolve through this, so
// the two peers can never end up on different servers.
export function resolveIceServer(chosen: string | undefined | null): string {
  return isSupportedIceServer(chosen) ? chosen : DEFAULT_SEND_OPTIONS.iceServer;
}

// Allowed chunk sizes offered in the UI — single source of truth for the
// sender options and for validating the `c` URL param on the receive page.
export const CHUNK_SIZE_OPTIONS: number[] = [8 * 1024, 16 * 1024, 32 * 1024, 64 * 1024, 128 * 1024];

export const DEFAULT_RECEIVE_OPTIONS: ReceiveOptions = {
  autoAccept: true,
  maxSize: 1024 * 1024 * 1024 // 1GB
};

export const WAIT_ICE_CANDIDATES_TIMEOUT = 3000; // 3 seconds

export const PROGRESS_UPDATE_UI_STEP = 3; // percentage
