---
type: 'Reference'
title: 'Quickstart: Zero Share P2P File Sharing'
openwiki_generated: true
verified:
  - by: openwiki/0.6.0
    at: 2026-10-01T19:50:36.439Z
sources:
  - id: openwiki-source-9ab161c6e9774cf771b19ced
    resource: repo://.zerofactory/precommit.sh
  - id: openwiki-source-c50574f22a4c0741148fc769
    resource: repo://astro.config.mjs
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-f582d8a11a0cfc8a438a5ae2
    resource: repo://src/components/OfferPage.svelte
  - id: openwiki-source-ea57456033ae6393e62158ed
    resource: repo://src/components/ReceivePage.svelte
  - id: openwiki-source-1b681c4ce8d10cbab258bb09
    resource: repo://src/pages/index.astro
  - id: openwiki-source-ef5b40568b7653d8929d5a0f
    resource: repo://src/pages/receive.astro
  - id: openwiki-source-ebef8d66c8ea768663c3c87f
    resource: repo://src/type.ts
  - id: openwiki-source-50c9d20caf7661d393640fd7
    resource: repo://src/utils/sdpEncode.ts
generated: { by: 'hermes', at: '2026-10-01T19:50:36.439Z' }
---

# Quickstart: Zero Share P2P File Sharing

**Zero Share** is a serverless, client-side P2P file-sharing web app. Two browsers share a file over a direct WebRTC data channel — no application server, no relay; the only external dependency is public STUN servers for NAT traversal. Optional per-file encryption (AES-256-GCM payload + RSA-OAEP key wrapping) protects content on top of DTLS. It is built as a static **Astro + Svelte 5** site and deployed to static hosting (GitHub Pages or any static host).

## How a transfer works (end-to-end)

1. **Alice (offer):** opens `/`, clicks _Generate Offer_. The app creates an `RTCPeerConnection`, a data channel, and an SDP offer, waits for ICE candidates (3 s timeout), and produces an **offer link** — `/receive?s=<encoded offer SDP>` plus optional params.
2. **Bob (answer):** opens the offer link. His browser decodes the SDP, generates an SDP answer + (if encrypted) a fresh RSA key pair, and produces the **answer code** `sdp|rsaPubBase64`.
3. **Alice accepts:** pastes or QR-scans the answer code; the channel opens on both sides.
4. **Transfer:** files are sent as protobuf `Message`s (metadata → receiver accept → ack-paced chunks), in either direction on the same channel.

### Wire formats

- **SDP encoding:** `sdp-compact` compaction + URL-safe substitutions `/`→`_`, `+`→`~`, `=`→`-` (reversed on decode). [`repo://src/utils/sdpEncode.ts#L1-L12`]
- **Offer link:** `?s=<offerSDP>` + optional `i=<stunUrl>` (STUN override), `c=<chunkBytes>` (validated against `CHUNK_SIZE_OPTIONS` on the receive side; anything else falls back to the 32 KB default), `p=<base64 RSA public key>` (encryption only).
- **Answer code:** `<encoded answer SDP>|<base64 RSA public key or empty>`.

## Where things live

| Area                                                    | Path                                                 |
| ------------------------------------------------------- | ---------------------------------------------------- |
| Offer (initiator) page                                  | `src/components/OfferPage.svelte`                    |
| Answer (responder) page                                 | `src/components/ReceivePage.svelte`                  |
| Sender / Receiver transfer engines                      | `src/components/sender/`, `src/components/receiver/` |
| Wire protocol (proto3 + ts-proto generated code)        | `src/proto/message.proto`, `src/proto/message.ts`    |
| Crypto (WebCrypto)                                      | `src/utils/crypto.ts`                                |
| Constants: STUN list, defaults, chunk options, timeouts | `src/configs.ts`                                     |
| Shared types & file lifecycle enums                     | `src/type.ts`                                        |
| Astro build config                                      | `astro.config.mjs`                                   |

### Task routing map

- **Peering / links / SDP / STUN / QR** → `subsystems/peering.md`
- **File protocol, chunking, flow control, validation** → `subsystems/file-transfer.md`
- **Encryption design & WebCrypto usage** → `subsystems/encryption.md`
- **System boundaries, control/data flow, security layering** → `architecture.md`
- **Build, test gates, deployment, precommit** → the Development section on this page

## Development

Requirements: Node (≥18) + npm.

```sh
npm install        # install
npm run dev        # local dev server (hot reload)
npm run build      # typecheck-free static build to ./build
npm run lint       # prettier --check . && eslint .
npm run format     # prettier --write .
npm run protogen   # regenerate src/proto/message.ts from message.proto (needs protoc)
```

**Verification gates for changes:** the repo has **no test suite** (no test script in `package.json`); `tsc --noEmit` typechecking plus `npm run build` plus `prettier --check` are the effective gates (see `operations.md`). Note: `astro check` is _not_ configured (no `@astrojs/check`/`typescript` devDeps) and its install prompt hangs non-interactive shells — do not run it.

**Conventions:** TypeScript strict, Svelte 5 runes style (`$state`/`$props`), Tailwind 4 + DaisyUI classes, Conventional Commits. Zero Factory's precommit hook runs `./.zerofactory/precommit.sh` (format → typecheck+build → test [none]).

## Known operational issues (from README)

- Some networks block the default Google STUN server → slow/failed candidate gathering; pick a different STUN via _Settings_ (propagated through the offer link's `i` param).
- Firewalls may block WebRTC data (UDP/ICE) during file sends.
