---
type: 'Reference'
title: 'Quickstart: Zero Share P2P File Sharing'
openwiki_generated: true
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
  - id: openwiki-source-578f160ff71c06304de2a610
    resource: repo://src/configs.ts
  - id: openwiki-source-1b681c4ce8d10cbab258bb09
    resource: repo://src/pages/index.astro
  - id: openwiki-source-ef5b40568b7653d8929d5a0f
    resource: repo://src/pages/receive.astro
  - id: openwiki-source-ebef8d66c8ea768663c3c87f
    resource: repo://src/type.ts
  - id: openwiki-source-50c9d20caf7661d393640fd7
    resource: repo://src/utils/sdpEncode.ts
generated: { by: 'hermes', at: '2026-10-13T12:04:42.015Z' }
verified:
  - by: openwiki/0.6.0
    at: 2026-10-13T12:04:42.015Z
---

# Quickstart: Zero Share P2P File Sharing

**Zero Share** is a serverless, client-side P2P file-sharing web app. Two browsers share a file over a direct WebRTC data channel — no application server, no relay; the only external dependency is a public STUN server for NAT traversal (a user-typed custom STUN/TURN URL is also accepted through the shared ICE-server predicate). Optional per-file encryption (AES-256-GCM payload + RSA-OAEP key wrapping) protects content on top of DTLS. It is built as a static **Astro + Svelte 5** site and deployed to static hosting (GitHub Pages or any static host).

## How a transfer works (end-to-end)

1. **Alice (offer):** opens `/`, clicks _Generate Offer_. The app creates an `RTCPeerConnection`, a data channel, and an SDP offer, waits for ICE candidates (3 s timeout), and produces an **offer link** — `/receive?s=<encoded offer SDP>` plus optional params.
2. **Bob (answer):** opens the offer link. His browser decodes the SDP, generates an SDP answer + (if encrypted) a fresh RSA key pair, and produces the **answer code** `sdp|rsaPubBase64`.
3. **Alice accepts:** pastes or QR-scans the answer code; the channel opens on both sides.
4. **Transfer:** files are sent as protobuf `Message`s (metadata → receiver accept → ack-paced chunks), in either direction on the same channel.

### Wire formats

- **SDP encoding:** `sdp-compact` compaction + URL-safe substitutions `/`→`_`, `+`→`~`, `=`→`-` (reversed on decode). `sdpDecode` throws synchronously on empty, invalid-base64, or non-SDP input, so both user-controllable call sites (the `s` link param on the receive page, the pasted/scanned answer code on the offer page) guard it with `try/catch` and surface an error toast instead of crashing the page (PR #45). [`repo://src/utils/sdpEncode.ts#L1-L14`], [`repo://tests/sdp-robustness.test.mjs`]
- **Offer link:** `?s=<offerSDP>` + optional `i=<iceServerUrl>` (the sender emits the shared-predicate-resolved value — built-in STUN allowlist or a well-formed `stun:`/`turn:` custom URL — and the receive side accepts it only when it passes the same `isSupportedIceServer` predicate, else the default ICE server is used with an error toast), `c=<chunkBytes>` (validated against `CHUNK_SIZE_OPTIONS` on the receive side; anything else falls back to the 32 KB default), `p=<base64 RSA public key>` (encryption only; a malformed key downgrades the session to plaintext with an error toast).
- **Answer code:** `<encoded answer SDP>|<base64 RSA public key or empty>` — an empty key portion is the receiver's deliberate plaintext downgrade and is handled, not treated as malformed.

## Where things live

| Area                                                                                                           | Path                                                 |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Offer (initiator) page                                                                                         | `src/components/OfferPage.svelte`                    |
| Answer (responder) page                                                                                        | `src/components/ReceivePage.svelte`                  |
| Sender / Receiver transfer engines                                                                             | `src/components/sender/`, `src/components/receiver/` |
| Wire protocol (proto3 + ts-proto generated code)                                                               | `src/proto/message.proto`, `src/proto/message.ts`    |
| Crypto (WebCrypto)                                                                                             | `src/utils/crypto.ts`                                |
| Store-only ZIP writer (bulk download)                                                                          | `src/utils/zip.ts`                                   |
| Per-key task serializer (chunk-order fix)                                                                      | `src/utils/serialize.ts`                             |
| Constants: STUN list, defaults, chunk options, timeouts                                                        | `src/configs.ts`                                     |
| Shared types & file lifecycle enums                                                                            | `src/type.ts`                                        |
| Astro build config                                                                                             | `astro.config.mjs`                                   |
| Regression tests (16 guards: crypto, ICE-server, chunking, offer/answer handling, SDP/message decode, QR, zip) | `tests/`                                             |

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
npm test           # sixteen regression guards: node --no-warnings --test "tests/*.test.mjs"
```

**Verification gates for changes:** `npm test` runs the Node built-in test runner over all sixteen `tests/*.test.mjs` regression guards — `node --no-warnings --test "tests/*.test.mjs"` (package.json `test` script, verbatim) — covering, among others, the RSA-OAEP modulus pinned at 2048 bits (`tests/crypto.test.mjs`), the store-only ZIP writer (`createZipStoreOnly` CRC-32 vectors + external-unzip round-trip), the per-file chunk-order serialization (`serializeTask` driven exactly as `onChunkData` wires it, with out-of-order mocked decryption), the `int64` `MetaData.size` wire encoding (PR #42: files ≥ 2 GiB no longer throw `invalid int32` during `Message.encode`), the receiver "Max Size" option values matching their labels plus the numeric coercion in `onChange` (PR #44: 10/100 MB options previously enforced KB limits), the guarded `sdpDecode` call sites plus the sdp-compact throw premise (PR #45: malformed SDP input in the `s` link param or answer code no longer crashes the page), the guarded `Message.decode` on peer-controlled data-channel bytes (PR #46: malformed/truncated protobuf frames no longer crash the page uncaught), the sender's numeric chunk-size handling (`Sender.sendNextChunk`'s `Number()` coercion + `OfferOptions.onChange`, PR #56: a Svelte 5 `<select> bind:value` string can no longer make offsets string-concatenate into one over-sized chunk), the answer-key plaintext downgrade (`parseAnswerCode` empty-key path, PR #50), the offer-link keypair mint-once race (`offerBuilt` guard, PR #55), the receive-page offer-processing failure state (PR #49), the ICE-server options propagation (PR #57), the shared ICE-server predicate round-trip through `isSupportedIceServer`/`resolveIceServer` in `src/configs.ts` (custom/TURN server chosen on the sender is honored by the receiver, PR #48), the DragAndDrop paste-listener scoping (PR #52), the reactive QrModal (PR #53), and the receiver's corrupt-chunk reject path (`rejectCorruptChunk` on AES-GCM auth failure, PR #54). (`--no-warnings` is passed because `sdp-robustness.test.mjs` registers a Node ESM resolve hook that deprecation-warns on newer runtimes.) The Zero Factory precommit hook runs `./.zerofactory/precommit.sh`, whose default/`all` path executes `format` (`npx prettier --write . && npx eslint . --fix`) → `build` (`npx tsc --noEmit && npm run build`) → `test` (`npm test` — all sixteen guards). Also note: `astro check` is _not_ configured (no `@astrojs/check` devDep) and its install prompt hangs non-interactive shells — do not run it.

**Conventions:** TypeScript strict, Svelte 5 runes style (`$state`/`$props`), Tailwind 4 + DaisyUI classes, Conventional Commits. Zero Factory's precommit hook runs `./.zerofactory/precommit.sh` (format → typecheck+build → test).

## Known operational issues (from README)

- Some networks block the default Google STUN server → slow/failed candidate gathering; pick a different STUN — or a custom/TURN URL, which round-trips through the shared `isSupportedIceServer` predicate — via _Settings_ (propagated through the offer link's `i` param).
- Firewalls may block WebRTC data (UDP/ICE) during file sends.
