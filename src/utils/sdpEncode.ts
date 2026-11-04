// URL-safe SDP wire codec.
//
// `sdpEncode` maps an arbitrary SDP string to the RFC3986 unreserved set
// `[A-Za-z0-9-._~]` so it can travel in a URL query param (`s`, `c`, `p`
// params) and in the pasted/QR-scanned answer code. It is UTF-8 encode ->
// standard base64 -> base64url alphabet (`+`->`-`, `/`->`_`) with no
// padding. `sdpDecode` is its exact inverse.
//
// This is deliberately a plain base64url codec, NOT a lossy SDP dictionary
// codec: sdp-compact@0.0.8's candidate/media dictionaries are asymmetric
// (its encode maps lowercase `udp` while browsers emit uppercase `UDP`,
// but its decode map still rewrites the `U` inside an uncompressed `UDP`
// token, corrupting it to `udpDP`), so the round-trip was not a true
// inverse and both peers silently dropped each other's ICE candidates.
// Base64url costs a few dozen characters more per link and is byte-stable.
//
// `sdpDecode` throws synchronously on malformed input (empty string,
// invalid base64, or a decoded payload that is not an SDP session
// description) — callers must guard with try/catch.

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

// UTF-8 bytes -> binary string, chunked so a very large SDP (hundreds of
// trickle candidates) cannot hit the `String.fromCharCode(...args)` limit.
function bytesToBinary(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return binary;
}

function toBase64Url(s: string): string {
  return btoa(bytesToBinary(new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  // Restore standard base64 (alphabet + `=` padding) before decoding.
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // fatal: reject truncated / invalid UTF-8 payloads.
  return UTF8_DECODER.decode(bytes);
}

export function sdpEncode(s: string): string {
  return toBase64Url(s);
}

// Throws synchronously on malformed input (empty string, invalid base64, or
// a decoded payload that is not an SDP session description) — callers must
// guard with try/catch.
export function sdpDecode(s: string): string {
  if (s.length === 0) throw new Error('empty SDP payload');
  const decoded = fromBase64Url(s);
  if (!decoded.startsWith('v=')) {
    throw new Error('decoded SDP payload is not a session description');
  }
  return decoded;
}
