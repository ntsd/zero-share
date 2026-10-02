---
type: 'Reference'
title: 'Subsystem: File Transfer Engine'
openwiki_generated: true
verified:
  - by: openwiki/0.6.0
    at: 2026-10-01T19:50:36.439Z
sources:
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-f582d8a11a0cfc8a438a5ae2
    resource: repo://src/components/OfferPage.svelte
  - id: openwiki-source-b44a738391e0dd972a16a1ef
    resource: repo://src/components/receiver/Receiver.svelte
  - id: openwiki-source-d6db73741d251c8c754ff256
    resource: repo://src/components/sender/Sender.svelte
  - id: openwiki-source-578f160ff71c06304de2a610
    resource: repo://src/configs.ts
  - id: openwiki-source-8ef4b7799f3c645f0b2b5ac2
    resource: repo://src/proto/message.proto
  - id: openwiki-source-ebef8d66c8ea768663c3c87f
    resource: repo://src/type.ts
  - id: openwiki-source-7273c5aba858442dede2d981
    resource: repo://src/utils/validator.ts
generated: { by: 'hermes', at: '2026-10-01T19:50:36.439Z' }
---

# Subsystem: File Transfer Engine

The transfer engine is the `Sender` and `Receiver` Svelte components plus the `src/proto/message` code generated from `src/proto/message.proto` (`npm run protogen` via `ts-proto`). It implements a small **receiver-acknowledged chunk protocol** over the WebRTC data channel.

## Message framing

Every data-channel message is a protobuf `Message`: a `file id` plus exactly one of three payloads — [`repo://src/proto/message.proto#L1-L31`]

- `metaData` (`MetaData {name, size, type, key}`) — announced by the sender before any bytes; `key` holds the RSA-wrapped per-file AES key (empty when encryption is off).
- `chunk` — one slice of file body (raw or encrypted).
- `receiveEvent` — receiver→sender control: `EVENT_RECEIVER_ACCEPT`, `EVENT_RECEIVER_REJECT`, `EVENT_RECEIVED_CHUNK`, `EVENT_VALIDATE_ERROR`.

**File ids are unique, not filenames.** The sender assigns each picked file `crypto.randomUUID()`, so two same-named files transferred in one session get distinct ids and never cross-wire chunks; display uses `metaData.name` only. [`repo://src/components/sender/Sender.svelte#L182-L215`]

## Sender state machine

Files live in a reactive `sendingFiles` map keyed by id, each carrying the `File`, `MetaData`, progress/bitrate, a `stop` flag, an `error`, and the per-file `aesKey`. Lifecycle: `Pending → WaitingAccept → Processing → Success`, with `Processing → Pending` (reset) on receiver reject or validate error. [`repo://src/components/sender/Sender.svelte#L21-L84`]

Flow for `onSend(key)`:

1. Register an `EventEmitter` for this file and bind handlers for the four `receiveEvent`s (routed by `receiveEventToJSON`).
2. Send the `metaData` message; status → `WaitingAccept`.
3. On `ACCEPT`: status → `Processing`, start the chunk loop.
4. On each `RECEIVED_CHUNK` ack: if `stop` or not `Processing`, reset to `Pending`; if `offset < metaData.size`, send the next chunk; else status → `Success` and toast. [`repo://src/components/sender/Sender.svelte#L46-L72`]
5. `REJECT` / `VALIDATE_ERROR`: set the error, toast, status → `Pending` (retryable via re-send).

Chunking: `sendNextChunk` slices `file.slice(offset, offset + chunkSize)`, reads it as an `ArrayBuffer`, encrypts it (when `isEncrypt` and `aesKey` present), and frames it as a `Message`.

**Empty-chunk guard:** if `buffer.byteLength === 0` while `offset < size`, the chunk size is invalid (e.g. a crafted `c` URL param producing NaN/0); the sender aborts with an "invalid chunk size" error instead of looping forever on zero-byte sends. [`repo://src/components/sender/Sender.svelte#L109-L125`]

Progress: computed as `offset/size * 100`; the reactive `progress` and `bitrate` are only updated every `PROGRESS_UPDATE_UI_STEP` (3) points using a non-reactive `fileStats` mirror — throttling UI updates during fast transfers. Pause/resume is the `stop` flag plus `onContinue`, which re-emits a synthetic `RECEIVED_CHUNK` to restart the loop. [`repo://src/components/sender/Sender.svelte#L34-L41`], [`repo://src/configs.ts#L35-L37`], [`repo://src/components/sender/Sender.svelte#L165-L172`]

## Receiver state machine

`receivingFiles` is a reactive map; per-file chunk accumulation (`receivingFileChunkMap`) and byte/progress counters (`receivingFileStatsMap`) are **deliberately non-reactive** plain objects to avoid re-rendering per chunk. [`repo://src/components/receiver/Receiver.svelte#L25-L33`]

`onMetaData(id, metaData)`:

1. If `isEncrypt && rsa`, unwrap `metaData.key` with the private RSA key into the file's `aesKey`.
2. Register the file at `WaitingAccept`.
3. Validate via `validateFileMetadata(metaData, receiveOptions.maxSize)` (default max 1 GB); on failure send `EVENT_VALIDATE_ERROR`, store the error, and stop.
4. If `autoAccept` (default on), immediately `onAccept(id)` — send `EVENT_RECEIVER_ACCEPT`, set `Processing`, and initialize the chunk/stats maps. Manual accept/deny is also available via the list UI. [`repo://src/components/receiver/Receiver.svelte#L35-L72`], [`repo://src/configs.ts#L30-L33`]

`onChunkData(id, chunk)` (acks before processing):

1. **Immediately** send `EVENT_RECEIVED_CHUNK` — the sender's next chunk only flows after this ack, which paces the transfer (backpressure).
2. Decrypt when encryption applies, append the plaintext buffer to `receivedChunks`, bump `receivedSize` and throttled progress/bitrate (same 3-point step).
3. When `receivedSize >= metaData.size`: build the file `Blob` **immediately and delete both per-file maps** — this releases the raw per-chunk buffers so a large file is not held twice in memory — then status → `Success` and toast. [`repo://src/components/receiver/Receiver.svelte#L74-L124`]

Removal/deny sends `EVENT_RECEIVER_REJECT` (if not already successful) and drops the file's state maps; download uses an object URL on the assembled `Blob`. [`repo://src/components/receiver/Receiver.svelte#L126-L153`]

## Validation & user-facing errors

`validateFileMetadata` is the single size gate (returns an `Error` with a `humanFileSize`-rendered limit message; undefined when OK). Sender-side validation runs at pick time without a limit; receiver-side enforces `maxSize`. Errors surface through the nanostores `toastAtom` via `addToastMessage`, which both components import. [`repo://src/utils/validator.ts#L1-L8`], [`repo://src/components/receiver/Receiver.svelte#L53-L67`], [`repo://src/stores/toastStore.ts`]

## Invariants & failure behavior

- **Chunk order is protocol-enforced, not channel-ordered**: the data channel is created `ordered: false`; correctness relies on the single-writer chunk loop per file (one `RECEIVED_CHUNK` → one chunk) plus per-file id isolation. [`repo://src/components/OfferPage.svelte#L79-L81`]
- A receiver ack for a stopped/idle file resets the sender file to `Pending` with progress 0 rather than erroring.
- Completion is exact-size based: both sides stop when the declared `metaData.size` is fully sent/received; there is no file trailer or checksum, so integrity relies on GCM authentication (encryption on) or TCP-less DTLS data integrity.
