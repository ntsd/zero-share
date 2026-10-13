---
type: 'Reference'
title: 'Architecture: Serverless WebRTC P2P Sharing'
openwiki_generated: true
verified:
  - by: openwiki/0.6.0
    at: 2026-10-13T12:04:42.015Z
sources:
  - id: openwiki-source-c50574f22a4c0741148fc769
    resource: repo://astro.config.mjs
  - id: openwiki-source-f582d8a11a0cfc8a438a5ae2
    resource: repo://src/components/OfferPage.svelte
  - id: openwiki-source-ea57456033ae6393e62158ed
    resource: repo://src/components/ReceivePage.svelte
  - id: openwiki-source-b44a738391e0dd972a16a1ef
    resource: repo://src/components/receiver/Receiver.svelte
  - id: openwiki-source-d6db73741d251c8c754ff256
    resource: repo://src/components/sender/Sender.svelte
  - id: openwiki-source-578f160ff71c06304de2a610
    resource: repo://src/configs.ts
  - id: openwiki-source-1b681c4ce8d10cbab258bb09
    resource: repo://src/pages/index.astro
  - id: openwiki-source-ef5b40568b7653d8929d5a0f
    resource: repo://src/pages/receive.astro
  - id: openwiki-source-8ef4b7799f3c645f0b2b5ac2
    resource: repo://src/proto/message.proto
  - id: openwiki-source-ebef8d66c8ea768663c3c87f
    resource: repo://src/type.ts
  - id: openwiki-source-825971ed9c72d5969af1b150
    resource: repo://src/utils/crypto.ts
  - id: openwiki-source-edd2d815ffc75024b7c21d45
    resource: repo://tests/protocol-size.test.mjs
generated: { by: 'hermes', at: '2026-10-13T12:04:42.015Z' }
---

# Architecture: Serverless WebRTC P2P Sharing

Zero Share is a **serverless, client-side P2P file-sharing web app**: two browsers connect directly over a WebRTC data channel and transfer files with no application backend. The only third-party network dependency is public STUN servers used for ICE candidate discovery.

## System boundaries

- **Static frontend, no server.** The app is an Astro site built in `output: 'static'` mode with Svelte (`client:only`) interactive components; deployment produces plain static files (GitHub Pages or `npm run build`). There is no server-side code and no relay server of any kind. [`repo://astro.config.mjs#L8-L13`]
- **Two routes, two roles.** `/` renders `OfferPage` (the initiator) and `/receive` renders `ReceivePage` (the responder). Both routes are thin Astro pages that mount a single Svelte component under the shared `MainLayout`. [`repo://src/pages/index.astro#L1-L10`], [`repo://src/pages/receive.astro#L1-L10`]
- **Dual-role transfer UI.** After the data channel opens, _each_ page mounts **both** a `Sender` and a `Receiver` and the user toggles between Send/Receive modes — either peer can transfer files in either direction over the same channel. [`repo://src/components/OfferPage.svelte#L387-L398`], [`repo://src/components/ReceivePage.svelte#L259-L293`]
- **Shared ICE-server resolution.** Peer connections are configured with a single ICE server (default `stun:stun.l.google.com:19302`, selectable from a built-in STUN list or a user-typed custom value). The value is resolved through the shared `isSupportedIceServer` / `resolveIceServer` predicates in `src/configs.ts`, which accept the built-in allowlist **plus any well-formed `stun:`/`turn:` URL** — and the sender enforces them on what it emits into the `i` link param **and** on its own `RTCPeerConnection`, while the receiver enforces the same predicate on what it accepts, so a custom/TURN server chosen on the sender is always honored by the peer and the two sides can never end up on different servers. Anything else falls back to the default with an error toast on both sides. There is no built-in TURN fallback list beyond the user-supplied value, and no relay server of any kind. [`repo://src/configs.ts#L3-L20`], [`repo://src/configs.ts#L47-L54`], [`repo://src/components/OfferPage.svelte#L63-L85`], [`repo://src/components/ReceivePage.svelte#L62-L77`]

## Control flow (connection establishment)

1. The **offer** peer creates an `RTCPeerConnection` (with the shared-predicate-resolved ICE server), opens a data channel (`ordered: false` — ordering is handled by the message protocol), generates a local offer, and encodes the SDP into a shareable `?s=...` link on the `/receive` route. Link generation waits for ICE candidates to finish, with a 3-second timeout fallback; the two build paths are guarded by a per-invocation `offerBuilt` flag so the link is built at most once, and the RSA keypair is minted **exactly once** at the top of `generateOfferLink()` (before the peer exists) so the timeout fallback can never rotate the key under an already-built link. Synchronous construction or offer-creation failures are caught and surfaced with a toast instead of an unhandled rejection that would leave the "Generating Offer" spinner stuck. [`repo://src/components/OfferPage.svelte#L140-L204`], [`repo://src/components/OfferPage.svelte#L63-L94`]
2. The **answer** peer opens the offer link, decodes the SDP from the URL, and sets it as the remote offer — inside `try/catch`, since `s` is user-controllable via the shared link and `sdpDecode` throws synchronously on empty, invalid-base64, or non-SDP input, so a crafted link surfaces an "Invalid SDP in link" error toast instead of crashing the whole page during load (PR #45). The promise of that step is kept and **awaited before `createAnswer`** (with a `signalingState === 'have-remote-offer'` check): without this, a rejected `setRemoteDescription` would leave the answer queued against a connection that can never answer, and the "Generating Answer" spinner would spin forever with zero feedback. Before freezing the answer it awaits the import of the offer peer's RSA key from the `p` param; a malformed key downgrades the session to plaintext (with an error toast) so the answer never advertises encryption the peer cannot honor, and produces an **answer code** = `sdpEncode(answerSdp) + '|' + base64(RSA public key)` (empty key portion when downgraded). The same 3-second ICE-candidate timeout fallback applies. [`repo://src/components/ReceivePage.svelte#L46-L59`], [`repo://src/components/ReceivePage.svelte#L138-L178`], [`repo://src/components/ReceivePage.svelte#L246-L256`]
3. The offer peer pastes (or QR-scans) the answer code and, when encryption is on, parses it (`parseAnswerCode` splits on the last `|`): a well-formed code with an **empty** key portion means the receiver deliberately downgraded to plaintext, so the offer peer follows it into plaintext (info toast, session encrypted=false) instead of bailing on the empty key and dead-ending the handshake; a missing separator or a damaged non-empty key still toasts an error and aborts, instead of leaving a half-configured connection. Then the answer is applied as the remote description — likewise inside a `try/catch`, since the pasted/scanned SDP may be malformed and would otherwise escape as an unhandled rejection with no visible error (PR #45). Once `dataChannel.onopen` fires, the transfer UI unlocks on both sides. [`repo://src/components/OfferPage.svelte#L218-L264`]

SDP text is made URL-safe by `sdp-compact` compaction plus character substitutions (`/`→`_`, `+`→`~`, `=`→`-`), keeping share links short and safe. `sdpDecode` throws synchronously on malformed input (empty, invalid base64, or a decompressed payload that is not SDP), so every caller must guard with `try/catch`. See `subsystems/peering.md` for the full link and code formats.

## Data flow (file transfer)

All traffic on the data channel is **proto3-framed `Message` bytes** — no ad-hoc text protocol. A `Message` carries a `file id` plus exactly one of:

- `metaData` — file name, size (int64 on the wire — commit 721c502 / PR #42 widened it from int32 so files ≥ 2 GiB no longer throw `invalid int32` during `Message.encode`), MIME type, and the RSA-wrapped per-file AES key (encryption mode only);
- `chunk` — a raw (or encrypted) slice of the file body;
- `receiveEvent` — receiver→sender control events (`ACCEPT`, `REJECT`, `RECEIVED_CHUNK`, `VALIDATE_ERROR`). [`repo://src/proto/message.proto#L1-L31`]

Both pages dispatch incoming messages with the same oneof switch on `metaData` / `chunk` / `receiveEvent`, routing to `Receiver.onMetaData`, `Receiver.onChunkData`, or `Sender.onReceiveEvent`. The `Message.decode` call on peer-controlled data-channel bytes is wrapped in `try/catch` on **both** pages: a malformed or truncated protobuf frame makes `decode` throw synchronously, which would otherwise crash the page uncaught (PR #46) — instead the frame is dropped and an "Invalid message from peer" toast fires. [`repo://src/components/OfferPage.svelte#L107-L127`], [`repo://src/components/ReceivePage.svelte#L107-L127`]

The transfer protocol is **receiver-ack chunking**: the sender emits metadata, waits for `RECEIVER_ACCEPT`, then sends chunks one per `RECEIVER_RECEIVED_CHUNK` acknowledgment — a simple backpressure loop that paces the transfer. File lifecycle is modeled per file as `Pending → WaitingAccept → Processing → Success` with error/reject returns to `Pending`. See `subsystems/file-transfer.md`.

## Security layering

1. **DTLS** — inherent to WebRTC; protects the data channel in transit but is exposed to MITM on the SDP offer/answer exchange (the links are unauthenticated).
2. **Optional application-layer encryption** — when enabled, each file is encrypted with its own **AES-256-GCM** key, and that key is wrapped with the receiver's **RSA-OAEP-2048** public key and delivered inside the `metaData` message. This makes file content confidential even if the SDP exchange is intercepted. It is off by default (`isEncrypt: false`). The offer side tracks the effective session encryption in `effectiveEncrypt` (re-synced on every options change, overridable to plaintext when the receiver downgrades via an empty-key answer code) rather than reading `sendOptions.isEncrypt` live. [`repo://src/utils/crypto.ts#L1-L11`], [`repo://src/components/OfferPage.svelte#L38`], [`repo://src/components/OfferPage.svelte#L266-L278`], [`repo://src/configs.ts#L41-L45`]. See `subsystems/encryption.md`.

## State model

File state is held entirely in client memory (Svelte 5 `$state` maps keyed by file id — `crypto.randomUUID()` on the sender side, so same-named files never collide). Reactivity-sensitive UI state (progress, bitrate) is throttled by keeping per-file stats in **non-reactive** maps and flushing to reactive state every `PROGRESS_UPDATE_UI_STEP` (3) percentage points, avoiding render storms during transfers. [`repo://src/type.ts#L1-L78`], [`repo://src/components/sender/Sender.svelte#L21-L38`], [`repo://src/components/receiver/Receiver.svelte#L25-L33`], [`repo://src/configs.ts#L37-L37`]

There is **no persistence**: received files are assembled into `Blob`s held in memory and downloaded on demand; nothing is stored in IndexedDB, localStorage, or server-side.

## Build & runtime stack

Astro 5 (static output) + Svelte 5 + Tailwind 4/DaisyUI; TypeScript with `tsc --noEmit` as the typecheck gate; PWA support via the `astrojs-service-worker` integration; protobuf code generated by `ts-proto` from `src/proto/message.proto` (`npm run protogen`). [`repo://astro.config.mjs#L1-L20`], [`repo://package.json#L6-L16`]
