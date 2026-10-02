---
type: 'Reference'
title: 'Subsystem: WebRTC Peering and SDP Links'
openwiki_generated: true
verified:
  - by: openwiki/0.6.0
    at: 2026-10-01T19:50:36.439Z
sources:
  - id: openwiki-source-f582d8a11a0cfc8a438a5ae2
    resource: repo://src/components/OfferPage.svelte
  - id: openwiki-source-2c97eb7066ea8ddc78db9f6f
    resource: repo://src/components/qr/QrModal.svelte
  - id: openwiki-source-f3d7d5bd99b2f092fad17667
    resource: repo://src/components/qr/ScanQrModal.svelte
  - id: openwiki-source-ea57456033ae6393e62158ed
    resource: repo://src/components/ReceivePage.svelte
  - id: openwiki-source-578f160ff71c06304de2a610
    resource: repo://src/configs.ts
  - id: openwiki-source-383b42ea5b1230160f031c34
    resource: repo://src/utils/path.ts
  - id: openwiki-source-50c9d20caf7661d393640fd7
    resource: repo://src/utils/sdpEncode.ts
generated: { by: 'hermes', at: '2026-10-01T19:50:36.439Z' }
---

# Subsystem: WebRTC Peering and SDP Links

Peering is the connection-establishment layer: it turns two browsers into connected WebRTC peers using only **shareable artifacts** — an offer link and an answer code. No signaling server exists.

## SDP encoding for URL transport

Raw SDP is not URL-safe and is long. `sdpEncode` compacts it with `sdp-compact` (`compactSDP`) and substitutes RFC-3986-unsafe characters: `/`→`_`, `+`→`~`, `=`→`-`. `sdpDecode` reverses the substitutions before `decompactSDP`, with an `isOffer` flag matching the SDP role. This keeps links short and copy/paste/QR friendly. [`repo://src/utils/sdpEncode.ts#L1-L12`]

## Offer link contract (`/receive?s=...&i=...&c=...&p=...`)

The offer page builds the link with `buildURL`, which joins the base URL, the `receive` path, and query params (empty values are omitted): [`repo://src/utils/path.ts#L5-L23`], [`repo://src/components/OfferPage.svelte#L43-L60`]

- **`s`** — the `sdpEncode`d local offer SDP. Required; the receive page redirects to origin and throws if absent. [`repo://src/components/ReceivePage.svelte#L27-L31`]
- **`i`** — STUN server override. Omitted when equal to the default; the receive page falls back to `DEFAULT_SEND_OPTIONS.iceServer` when absent. [`repo://src/components/OfferPage.svelte#L51-L59`], [`repo://src/components/ReceivePage.svelte#L52-L52`]
- **`c`** — chunk size. Omitted when equal to the default 32 KB.
- **`p`** — base64 RSA public key (SPKI) of the offer peer, present only when encryption is on.

STUN config comes from the built-in `STUN_SERVERS` list (Google/sipgate/nextcloud/myvoipapp); the peer connection is created with a single `iceServers` entry from the selected `i` value. No TURN is used. [`repo://src/configs.ts#L3-L14`], [`repo://src/components/OfferPage.svelte#L62-L73`], [`repo://src/components/ReceivePage.svelte#L65-L67`]

**`c` validation (user-controllable input).** Because the link is shared and `c` is attacker-influenceable, the receive page does not trust it blindly: it `parseInt`s `c` and accepts it **only if it is in `CHUNK_SIZE_OPTIONS`** (8/16/32/64/128 KB); NaN, 0, negative, or any other value falls back to the 32 KB default. This single source of truth (`CHUNK_SIZE_OPTIONS`) is also what the sender options UI offers. [`repo://src/components/ReceivePage.svelte#L37-L42`], [`repo://src/configs.ts#L26-L28`]

## Answer-code wire format

The answer page produces `answerSDP = sdpEncode(localAnswerSdp) + '|' + publicKeyBase64`. The `|` delimiter is unambiguous because the encoded SDP character set excludes it. `publicKeyBase64` is empty unless encryption is on. The offer page's `acceptAnswer` splits on `|`, imports the RSA public key (when `isEncrypt`), and `setRemoteDescription` with the decoded answer. [`repo://src/components/ReceivePage.svelte#L115-L138`], [`repo://src/components/OfferPage.svelte#L141-L153`]

## ICE candidate wait + timeout fallback

Both sides wait for ICE candidates to drain before freezing the SDP, but cap the wait at `WAIT_ICE_CANDIDATES_TIMEOUT` (3 s). If candidates don't finish in time, a `setTimeout` builds the link/code from the current `localDescription` anyway and shows a toast — the connection still forms (possibly slower) rather than hanging. [`repo://src/components/OfferPage.svelte#L114-L134`], [`repo://src/components/ReceivePage.svelte#L122-L137`]

## Data channel role swap

The **offer** side is the data-channel creator (`createDataChannel('data', { ordered: false })`); the **answer** side receives it via `ondatachannel`. Both then install the identical message-dispatch handlers. After `onopen`, the transfer UI (Send/Receive toggle) unlocks on both sides. [`repo://src/components/OfferPage.svelte#L79-L97`], [`repo://src/components/ReceivePage.svelte#L69-L97`]

## QR exchange

`QrModal` renders any shareable artifact (offer link or answer code) as a QR code via `@nuintun/qrcode` (byte mode, US-ASCII ECI 27, error-correction level M, auto version). `ScanQrModal` wraps `qr-scanner` to decode a counterparty's QR from the camera and feed it back as if pasted (offer page uses it to accept the answer; the receive page shows its answer QR). This makes link/code exchange camera-only, no keyboard. [`repo://src/components/qr/QrModal.svelte#L1-L32`], [`repo://src/components/qr/ScanQrModal.svelte#L1-L32`], [`repo://src/components/OfferPage.svelte#L223-L231`]

## Failure behavior

- Missing/empty `s` on the receive page: redirect to origin + throw (no offer to answer). [`repo://src/components/ReceivePage.svelte#L28-L31`]
- `onicecandidateerror`, `dataChannel.onerror`, `onclose`: toast an error, clear `isConnecting`, and (offer side) blank the offer link so a stale link isn't reused. [`repo://src/components/OfferPage.svelte#L75-L107`]
- Encryption off: `p`/public key are absent, `isEncrypt` derives false on the receive side, and peering is unencrypted end-to-end at this layer. [`repo://src/components/ReceivePage.svelte#L33-L49`]
