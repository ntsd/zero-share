import { compactSDP, decompactSDP } from 'sdp-compact';

// RFC3986 only support characters `[A-Za-z0-9\-._~]+`
// replace `/` with `_`
// replace `+` with `~`
export function sdpEncode(s: string): string {
  return compactSDP(s).replace(/\//g, '_').replace(/\+/g, '~').replace(/=/g, '-');
}

export function sdpDecode(s: string, isOffer: boolean): string {
  return decompactSDP(s.replace(/_/g, '/').replace(/~/g, '+').replace(/-/g, '='), isOffer);
}
