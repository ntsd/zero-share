---
type: 'Reference'
title: 'Subsystem: WebRTC Peering and SDP Links'
openwiki_generated: true
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
  - id: openwiki-source-43ba2ea6141a6d37347e98ea
    resource: repo://src/utils/peerMessage.ts
  - id: openwiki-source-b35e441477848e0de18eba3f
    resource: repo://src/utils/qr.ts
  - id: openwiki-source-50c9d20caf7661d393640fd7
    resource: repo://src/utils/sdpEncode.ts
  - id: openwiki-source-c738ae16748cba244df3bf6f
    resource: repo://tests/ice-server-consistency.test.mjs
  - id: openwiki-source-cbda1b574339ff50701cd203
    resource: repo://tests/offer-peer-lifecycle.test.mjs
  - id: openwiki-source-6620ca09e313d24486b5e413
    resource: repo://tests/peer-message-handler.test.mjs
  - id: openwiki-source-dec647b66ef3761a096ea9d6
    resource: repo://tests/qr.test.mjs
  - id: openwiki-source-d08c804026ad08a5eda0bd6a
    resource: repo://tests/receiver-connection-lost.test.mjs
  - id: openwiki-source-cc2aa5000eb243dbf0af9518
    resource: repo://tests/regen-offer-stale-peer-crypto.test.mjs
  - id: openwiki-source-1a1e198fafbdfd7512e4d6ab
    resource: repo://tests/scan-qr-lifecycle.test.mjs
  - id: openwiki-source-cc4834bd7be0e4e06ab95a6b
    resource: repo://tests/sdp-robustness.test.mjs
  - id: openwiki-source-7be198dd84c7db602ffe529e
    resource: repo://tests/sender-connection-lost.test.mjs
generated: { by: 'hermes', at: '2026-10-15T12:05:18.885Z' }
verified:
  - by: openwiki/0.6.0
    at: 2026-10-15T12:05:18.885Z
---

# Subsystem: WebRTC Peering and SDP Links

Peering is the connection-establishment layer: it turns two browsers into connected WebRTC peers using only **shareable artifacts** — an offer link and an answer code. No signaling server exists.

## SDP encoding for URL transport

Raw SDP is not URL-safe and is long. `sdpEncode` compacts it with `sdp-compact` (`compactSDP`) and substitutes RFC-3986-unsafe characters: `/`→`_`, `+`→`~`, `=`→`-`. `sdpDecode` reverses the substitutions before `decompactSDP`, with an `isOffer` flag matching the SDP role. This keeps links short and copy/paste/QR friendly. `sdpDecode` **throws synchronously** on malformed input — empty string, invalid base64, or a decompressed payload that is not SDP (PR #45 documented the contract in source; `tests/sdp-robustness.test.mjs` pins that sdp-compact v0.0.8 still throws), so every caller of user-controllable input must guard it with `try/catch`. [`repo://src/utils/sdpEncode.ts#L1-L14`], [`repo://tests/sdp-robustness.test.mjs`]

## Offer link contract (`/receive?s=...&i=...&c=...&p=...`)

The offer page builds the link with `buildURL`, which joins the base URL, the `receive` path, and query params (empty values are omitted): [`repo://src/utils/path.ts#L5-L23`], [`repo://src/components/OfferPage.svelte#L75-L90`]

- **`s`** — the `sdpEncode`d local offer SDP. Required; the receive page redirects to origin and throws if absent. [`repo://src/components/ReceivePage.svelte#L27-L31`]
- **`i`** — ICE server override (STUN, or a user-typed TURN/custom value). The sender emits `resolveIceServer(sendOptions.iceServer)` — omitted when equal to the default — and the receive page accepts it **only when it passes the shared `isSupportedIceServer` predicate** (built-in STUN allowlist **plus any well-formed `stun:`/`turn:` URL**); anything else falls back to `DEFAULT_SEND_OPTIONS.iceServer` with an error toast, so both peers always resolve to the same server and a shared link can never point the peer's WebRTC stack at a malformed or attacker-controlled value. [`repo://src/components/OfferPage.svelte#L75-L90`], [`repo://src/components/ReceivePage.svelte#L62-L77`]
- **`c`** — chunk size. Omitted when equal to the default 32 KB.
- **`p`** — base64 RSA public key (SPKI) of the offer peer, present only when encryption is on. The receive side does not trust the param blindly: the import is caught, and a malformed base64/SPKI value downgrades the session to plaintext with an error toast instead of rejecting or silently sending with an undefined key. [`repo://src/components/ReceivePage.svelte#L46-L59`]

ICE config comes from the shared `isSupportedIceServer` predicate in `src/configs.ts`, which accepts the built-in `STUN_SERVERS` list (Google/sipgate/nextcloud/myvoipapp/voipstunt; the nextcloud relay is `stuns:` because it is served over TLS) **plus any well-formed `stun:`/`stuns:`/`turn:`/`turns:` URL** the sender types into the custom field. The offer page resolves both its `RTCPeerConnection` `iceServers` and the link's `i` param through `resolveIceServer`, and the receive page validates `i` with the same predicate, so a custom/TURN server chosen on the sender is honored by the receiver — asymmetric ICE servers can no longer silently break NAT traversal or TURN relaying. A value the sender rejects gets a visible "Invalid ICE server, using default" toast instead of a silent fallback. [`repo://src/configs.ts#L3-L35`], [`repo://src/configs.ts#L47-L54`], [`repo://src/components/OfferPage.svelte#L75-L106`], [`repo://src/components/ReceivePage.svelte#L62-L77`], [`repo://tests/ice-server-consistency.test.mjs`]

**`c` validation (user-controllable input).** Because the link is shared and `c` is attacker-influenceable, the receive page does not trust it blindly: it `parseInt`s `c` and accepts it **only if it is in `CHUNK_SIZE_OPTIONS`** (8/16/32/64/128 KB); NaN, 0, negative, or any other value falls back to the 32 KB default. This single source of truth (`CHUNK_SIZE_OPTIONS`) is also what the sender options UI offers. [`repo://src/components/ReceivePage.svelte#L38-L43`], [`repo://src/configs.ts#L56-L58`]

## Answer-code wire format

The answer page produces `answerSDP = sdpEncode(localAnswerSdp) + '|' + publicKeyBase64`. The `|` delimiter is unambiguous because the encoded SDP character set excludes it. `publicKeyBase64` is empty when the receiver downgraded to plaintext (malformed `p` key) — that empty-key code is a **valid, intentional artifact**, not a corrupted one. The offer page's `acceptAnswer` parses with `parseAnswerCode`, which splits on the **last** `|` (safe even if a key portion ever contains one) and distinguishes a missing separator (truly malformed) from a well-formed code with an empty key: on the latter it follows the receiver into plaintext (`effectiveEncrypt = false`, info toast) instead of bailing on the empty key and dead-ending the handshake; on a missing separator or a damaged non-empty key it toasts "Invalid encryption key in answer code" and returns before `setRemoteDescription`. On success the SDP decode + `setRemoteDescription` runs inside its own `try/catch` (PR #45): the answer code is user-pasted or QR-scanned with no validation, and `sdpDecode` throwing on a damaged payload would otherwise escape as an unhandled rejection, so it toasts "Invalid answer code" instead. The receive page likewise decodes the user-controllable `s` param and calls `setRemoteDescription` inside a `try/catch` that toasts "Invalid SDP in link" instead of crashing the page during load (PR #45). [`repo://src/components/ReceivePage.svelte#L185-L198`], [`repo://src/components/OfferPage.svelte#L276-L333`], [`repo://src/components/ReceivePage.svelte#L138-L154`]

## ICE candidate wait + timeout fallback

Both sides wait for ICE candidates to drain before freezing the SDP, but cap the wait at `WAIT_ICE_CANDIDATES_TIMEOUT` (3 s). If candidates don't finish in time, a `setTimeout` builds the link/code from the current `localDescription` anyway and shows a toast — the connection still forms (possibly slower) rather than hanging. On the offer side the two build paths are raced safely: the RSA keypair is minted **once** at the top of `generateOfferLink` and a per-invocation `offerBuilt` flag is claimed synchronously by whichever path (candidate completion or timeout) builds first, so the link — and its `p` key — is built at most once per invocation; and the whole generation is wrapped in `try/catch`, so a synchronous `RTCPeerConnection`/`createDataChannel`/`createOffer`/`setLocalDescription` failure toasts "Could not generate the offer" and re-enables the button instead of leaving the "Generating Offer" spinner stuck with an unhandled rejection.

**Regeneration is generation-safe.** A stale 3 s timer is a real hazard: its closure holds the previous generation's `publicKeyBase64`, but its guard reads the script-scope `connection` — after a regeneration that is the _new_ peer, so without a token check the timer would build a link whose `p` key belongs to the old (re-minted, now discarded) keypair and silently break every subsequent encrypted transfer. `generateOfferLink` therefore, before minting: clears the tracked `iceCandidateTimer`, nulls the old data channel's handlers and closes it, closes the old `RTCPeerConnection` (guarded on `connectionState !== 'closed'`, since `close()` throws `InvalidStateError` on an already-settled peer), resets the settled peer crypto (`rsaPub = undefined`, `effectiveEncrypt` re-pinned from the live setting — so the new generation never encrypts with the previous peer's RSA key or the previous session's mode, PR #68) and the dead generation's UI state (new-file badge, `isConnecting`, pending answer code), and bumps a monotonically increasing `offerGeneration` counter; the timeout fallback re-checks its captured generation against the current one at fire time and bails if it is stale. [`repo://src/components/OfferPage.svelte#L153-L284`], [`repo://src/components/ReceivePage.svelte#L191-L205`], [`repo://src/configs.ts#L65`], [`repo://tests/offer-peer-lifecycle.test.mjs`], [`repo://tests/regen-offer-stale-peer-crypto.test.mjs`]

## Data channel role swap

The **offer** side is the data-channel creator (`createDataChannel('data', { ordered: false })`); the **answer** side receives it via `ondatachannel`. Both then install the same `handlePeerMessage` handler from `src/utils/peerMessage.ts` (deduplicated from two identical per-page handlers, PR #71), which dispatches the oneof payloads to `Receiver`/`Sender` with `Message.decode` on peer-controlled bytes guarded by `try/catch` (toast + drop the frame instead of an uncaught crash, PR #46). After `onopen`, the transfer UI (Send/Receive toggle) unlocks on both sides. Both pages additionally wire the channel's `onerror`/`onclose` to `sender?.onChannelClose()` / `receiver?.onChannelClose()` so a dead channel propagates the "connection lost" state into the file pipelines (PR #74). [`repo://src/components/OfferPage.svelte#L112-L150`], [`repo://src/components/ReceivePage.svelte#L99-L136`], [`repo://src/utils/peerMessage.ts`]

## QR exchange

`QrModal` renders any shareable artifact (offer link or answer code) as a QR code — byte mode, US-ASCII ECI 27, error-correction level M, auto version — via `buildQrDataUrl` in `src/utils/qr.ts`, and the data URL is **derived** (`$derived`) from the `qrData` prop so the QR always encodes the _current_ artifact: re-generating the offer (or any `qrData` change) re-renders the code instead of showing the stale mount-time copy (PR #53). `ScanQrModal` wraps `qr-scanner` to decode a counterparty's QR from the camera and feed it back as if pasted (offer page uses it to accept the answer; the receive page shows its answer QR). This makes link/code exchange camera-only, no keyboard. **Camera lifecycle is explicit:** a successful scan closes the modal programmatically (the checkbox `change` never fires), so `ScanQrModal` calls `stop()` on the scanner in the decode callback to release the camera stream + decode worker, and `onDestroy` repeats it if the component unmounts mid-scan; `stop()` is a no-op when already stopped. Both modals use per-instance DOM ids from a module-scope counter (safe because the pages mount Svelte `client:only` — no SSR), so multiple modals on one page never share toggles or video elements. [`repo://src/utils/qr.ts#L1-L29`], [`repo://src/components/qr/QrModal.svelte`], [`repo://src/components/qr/ScanQrModal.svelte`], [`repo://src/components/OfferPage.svelte#L414-L430`], [`repo://tests/qr.test.mjs`], [`repo://tests/scan-qr-lifecycle.test.mjs`]

## Failure behavior

- Missing/empty `s` on the receive page: redirect to origin + throw (no offer to answer). [`repo://src/components/ReceivePage.svelte#L28-L31`]
- **Malformed `s` on the receive page (PR #45):** the `s` param of a shared link is user-controllable; `sdpDecode` + `setRemoteDescription` in `setOfferSDP` run inside `try/catch`, so a crafted/truncated link toasts "Invalid SDP in link" instead of crashing the whole page during load. [`repo://src/components/ReceivePage.svelte#L138-L154`], [`repo://tests/sdp-robustness.test.mjs`]
- **Offer-processing failure dead-ends no longer (PR #49):** if the remote offer cannot be applied, `offerFailed` is set and the UI replaces the perpetual "Generating Answer" spinner with an error state ("Could not connect: the offer in the link is invalid / Ask the sender to generate a new offer link"); `generateAnswerSDP` awaits the offer-settling promise and checks `signalingState === 'have-remote-offer'` before `createAnswer`, and the whole generation is fire-and-forget with a `.catch` that surfaces any remaining rejection. [`repo://src/components/ReceivePage.svelte#L78-L83`], [`repo://src/components/ReceivePage.svelte#L168-L213`], [`repo://src/components/ReceivePage.svelte#L246-L256`], [`repo://tests/offer-processing-failure.test.mjs`]
- **Malformed answer code on the offer page (PR #45):** the pasted/scanned answer SDP is decoded inside `try/catch` in `acceptAnswer`; a damaged payload toasts "Invalid answer code" instead of an unhandled rejection with no visible error. [`repo://src/components/OfferPage.svelte#L320-L332`], [`repo://tests/sdp-robustness.test.mjs`]
- `onicecandidateerror`, `dataChannel.onerror`, `onclose`: toast an error, clear `isConnecting`, and (offer side) blank the offer link so a stale link isn't reused; both `onerror` and `onclose` additionally call `sender?.onChannelClose()` / `receiver?.onChannelClose()` so in-flight/queued files on both sides exit with an accurate "connection lost" error instead of dead-ending or re-firing false per-chunk errors (PR #74); offer-generation failures (synchronous constructor throws or rejected `createOffer`/`setLocalDescription`) toast "Could not generate the offer" and re-enable the button. [`repo://src/components/OfferPage.svelte#L108-L150`], [`repo://src/components/OfferPage.svelte#L153-L284`], [`repo://src/components/ReceivePage.svelte#L119-L136`]
- Encryption off: `p`/public key are absent, `isEncrypt` derives false on the receive side, and peering is unencrypted end-to-end at this layer. A malformed `p` (or an `i` outside the shared predicate) is likewise downgraded/fallen-back-to-default — with a toast — so the session never advertises what it cannot honor. [`repo://src/components/ReceivePage.svelte#L34-L37`], [`repo://src/components/ReceivePage.svelte#L46-L77`]
