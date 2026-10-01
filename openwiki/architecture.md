---
type: 'Reference'
title: 'Architecture: Serverless WebRTC P2P Sharing'
openwiki_generated: true
verified:
  - by: openwiki/0.6.0
    at: 2026-10-01T19:50:36.439Z
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
generated: { by: 'hermes', at: '2026-10-01T19:50:36.439Z' }
---

# Architecture: Serverless WebRTC P2P Sharing

Zero Share is a **serverless, client-side P2P file-sharing web app**: two browsers connect directly over a WebRTC data channel and transfer files with no application backend. The only third-party network dependency is public STUN servers used for ICE candidate discovery.

## System boundaries

- **Static frontend, no server.** The app is an Astro site built in `output: 'static'` mode with Svelte (`client:only`) interactive components; deployment produces plain static files (GitHub Pages or `npm run build`). There is no server-side code and no relay server of any kind. [`repo://astro.config.mjs#L8-L13`]
- **Two routes, two roles.** `/` renders `OfferPage` (the initiator) and `/receive` renders `ReceivePage` (the responder). Both routes are thin Astro pages that mount a single Svelte component under the shared `MainLayout`. [`repo://src/pages/index.astro#L1-L10`], [`repo://src/pages/receive.astro#L1-L10`]
- **Dual-role transfer UI.** After the data channel opens, _each_ page mounts **both** a `Sender` and a `Receiver` and the user toggles between Send/Receive modes — either peer can transfer files in either direction over the same channel. [`repo://src/components/OfferPage.svelte#L232-L276`], [`repo://src/components/ReceivePage.svelte#L179-L214`]
- **Public STUN only.** Peer connections are configured with a single STUN URL (default `stun:stun.l.google.com:19302`, selectable from a built-in list, overridable via the `i` URL param). There is no TURN fallback in the codebase. [`repo://src/configs.ts#L3-L14`], [`repo://src/configs.ts#L20-L24`], [`repo://src/components/ReceivePage.svelte#L52-L52`]

## Control flow (connection establishment)

1. The **offer** peer creates an `RTCPeerConnection`, opens a data channel (`ordered: false` — ordering is handled by the message protocol), generates a local offer, and encodes the SDP into a shareable `?s=...` link on the `/receive` route. Link generation waits for ICE candidates to finish, with a 3-second timeout fallback. [`repo://src/components/OfferPage.svelte#L62-L134`]
2. The **answer** peer opens the offer link, decodes the SDP from the URL, sets it as the remote offer, creates a local answer, and produces an **answer code** = `sdpEncode(answerSdp) + '|' + base64(RSA public key)`. [`repo://src/components/ReceivePage.svelte#L99-L138`]
3. The offer peer pastes (or QR-scans) the answer code, imports the RSA public key, and applies the answer as the remote description. Once `dataChannel.onopen` fires, the transfer UI unlocks on both sides. [`repo://src/components/OfferPage.svelte#L141-L153`]

SDP text is made URL-safe by `sdp-compact` compaction plus character substitutions (`/`→`_`, `+`→`~`, `=`→`-`), keeping share links short and safe. See `subsystems/peering.md` for the full link and code formats.

## Data flow (file transfer)

All traffic on the data channel is **proto3-framed `Message` bytes** — no ad-hoc text protocol. A `Message` carries a `file id` plus exactly one of:

- `metaData` — file name, size, MIME type, and the RSA-wrapped per-file AES key (encryption mode only);
- `chunk` — a raw (or encrypted) slice of the file body;
- `receiveEvent` — receiver→sender control events (`ACCEPT`, `REJECT`, `RECEIVED_CHUNK`, `VALIDATE_ERROR`). [`repo://src/proto/message.proto#L1-L31`]

Both pages dispatch incoming messages with the same oneof switch on `metaData` / `chunk` / `receiveEvent`, routing to `Receiver.onMetaData`, `Receiver.onChunkData`, or `Sender.onReceiveEvent`. [`repo://src/components/OfferPage.svelte#L86-L97`], [`repo://src/components/ReceivePage.svelte#L77-L88`]

The transfer protocol is **receiver-ack chunking**: the sender emits metadata, waits for `RECEIVER_ACCEPT`, then sends chunks one per `RECEIVER_RECEIVED_CHUNK` acknowledgment — a simple backpressure loop that paces the transfer. File lifecycle is modeled per file as `Pending → WaitingAccept → Processing → Success` with error/reject returns to `Pending`. See `subsystems/file-transfer.md`.

## Security layering

1. **DTLS** — inherent to WebRTC; protects the data channel in transit but is exposed to MITM on the SDP offer/answer exchange (the links are unauthenticated).
2. **Optional application-layer encryption** — when enabled, each file is encrypted with its own **AES-256-GCM** key, and that key is wrapped with the receiver's **RSA-OAEP-1024** public key and delivered inside the `metaData` message. This makes file content confidential even if the SDP exchange is intercepted. It is off by default (`isEncrypt: false`). [`repo://src/utils/crypto.ts#L1-L23`], [`repo://src/components/OfferPage.svelte#L43-L48`], [`repo://src/configs.ts#L20-L24`]. See `subsystems/encryption.md`.

## State model

File state is held entirely in client memory (Svelte 5 `$state` maps keyed by file id — `crypto.randomUUID()` on the sender side, so same-named files never collide). Reactivity-sensitive UI state (progress, bitrate) is throttled by keeping per-file stats in **non-reactive** maps and flushing to reactive state every `PROGRESS_UPDATE_UI_STEP` (3) percentage points, avoiding render storms during transfers. [`repo://src/type.ts#L1-L78`], [`repo://src/components/sender/Sender.svelte#L21-L38`], [`repo://src/components/receiver/Receiver.svelte#L25-L33`], [`repo://src/configs.ts#L37-L37`]

There is **no persistence**: received files are assembled into `Blob`s held in memory and downloaded on demand; nothing is stored in IndexedDB, localStorage, or server-side.

## Build & runtime stack

Astro 5 (static output) + Svelte 5 + Tailwind 4/DaisyUI; TypeScript with `tsc --noEmit` as the typecheck gate; PWA support via the `astrojs-service-worker` integration; protobuf code generated by `ts-proto` from `src/proto/message.proto` (`npm run protogen`). [`repo://astro.config.mjs#L1-L20`], [`repo://package.json#L6-L15`]
