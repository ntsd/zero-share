---
type: 'Reference'
title: 'Subsystem: File Transfer Engine'
openwiki_generated: true
sources:
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-f6525eb975fe7a351f8724c4
    resource: repo://src/components/OfferOptions.svelte
  - id: openwiki-source-f582d8a11a0cfc8a438a5ae2
    resource: repo://src/components/OfferPage.svelte
  - id: openwiki-source-b44a738391e0dd972a16a1ef
    resource: repo://src/components/receiver/Receiver.svelte
  - id: openwiki-source-42050754cc86d3d555b1aa6e
    resource: repo://src/components/receiver/ReceiverOptions.svelte
  - id: openwiki-source-b69214e91586f75042e77440
    resource: repo://src/components/sender/DragAndDrop.svelte
  - id: openwiki-source-d6db73741d251c8c754ff256
    resource: repo://src/components/sender/Sender.svelte
  - id: openwiki-source-578f160ff71c06304de2a610
    resource: repo://src/configs.ts
  - id: openwiki-source-8ef4b7799f3c645f0b2b5ac2
    resource: repo://src/proto/message.proto
  - id: openwiki-source-ebef8d66c8ea768663c3c87f
    resource: repo://src/type.ts
  - id: openwiki-source-31a6462697049dbc743cb89f
    resource: repo://src/utils/serialize.ts
  - id: openwiki-source-7273c5aba858442dede2d981
    resource: repo://src/utils/validator.ts
  - id: openwiki-source-8439c153cd0cf35493f27a86
    resource: repo://src/utils/zip.ts
  - id: openwiki-source-517b24ae8c4effd72d38e04d
    resource: repo://tests/drag-drop-paste.test.mjs
  - id: openwiki-source-edd2d815ffc75024b7c21d45
    resource: repo://tests/protocol-size.test.mjs
  - id: openwiki-source-7ea415ea06881fb9b2c5ec63
    resource: repo://tests/receiver-chunk-failure.test.mjs
  - id: openwiki-source-c4b2cf9b87c8a0dd3815ff97
    resource: repo://tests/receiver-chunk-order.test.mjs
  - id: openwiki-source-4a9f54b4f4a2e988b0daae2f
    resource: repo://tests/receiver-options-size.test.mjs
  - id: openwiki-source-a289fc8c0ae9be75658a2b82
    resource: repo://tests/sender-chunk-size.test.mjs
  - id: openwiki-source-408384ecc13a9dc3929f90a4
    resource: repo://tests/zip.test.mjs
generated: { by: 'hermes', at: '2026-10-13T12:04:42.015Z' }
verified:
  - by: openwiki/0.6.0
    at: 2026-10-13T12:04:42.015Z
---

# Subsystem: File Transfer Engine

The transfer engine is the `Sender` and `Receiver` Svelte components plus the `src/proto/message` code generated from `src/proto/message.proto` (`npm run protogen` via `ts-proto`). It implements a small **receiver-acknowledged chunk protocol** over the WebRTC data channel.

## Message framing

Every data-channel message is a protobuf `Message`: a `file id` plus exactly one of three payloads — [`repo://src/proto/message.proto#L1-L31`]

- `metaData` (`MetaData {name, size, type, key}`) — announced by the sender before any bytes; `key` holds the RSA-wrapped per-file AES key (empty when encryption is off). `size` is `int64` on the wire (PR #42 / commit 721c502 widened it from `int32`), so files ≥ 2 GiB no longer throw `invalid int32` during `Message.encode`.
- `chunk` — one slice of file body (raw or encrypted).
- `receiveEvent` — receiver→sender control: `EVENT_RECEIVER_ACCEPT`, `EVENT_RECEIVER_REJECT`, `EVENT_RECEIVED_CHUNK`, `EVENT_VALIDATE_ERROR`.

**File ids are unique, not filenames.** The sender assigns each picked file `crypto.randomUUID()`, so two same-named files transferred in one session get distinct ids and never cross-wire chunks; display uses `metaData.name` only. [`repo://src/components/sender/Sender.svelte#L195-L228`]

**File pick & paste scoping.** Files enter the session via `DragAndDrop` (drop, file picker, or clipboard paste). Its document-level `paste` listener is scoped: it ignores events whose target is an `INPUT`, `TEXTAREA`, `SELECT`, or content-editable element — so pasting an answer code or a custom ICE server value into any text field on the page no longer silently adds a stray `clipboard.txt` to the sender file list (PR #52) — and the listener is removed in `onDestroy` so it never outlives the component. [`repo://src/components/sender/DragAndDrop.svelte#L98-L134`], [`repo://tests/drag-drop-paste.test.mjs`]

## Sender state machine

Files live in a reactive `sendingFiles` map keyed by id, each carrying the `File`, `MetaData`, progress/bitrate, a `stop` flag, an `error`, and the per-file `aesKey`. Lifecycle: `Pending → WaitingAccept → Processing → Success`, with `Processing → Pending` (reset) on receiver reject or validate error. [`repo://src/components/sender/Sender.svelte#L21-L84`]

Flow for `onSend(key)`:

1. Register an `EventEmitter` for this file and bind handlers for the four `receiveEvent`s (routed by `receiveEventToJSON`).
2. Send the `metaData` message; status → `WaitingAccept`.
3. On `ACCEPT`: status → `Processing`, start the chunk loop.
4. On each `RECEIVED_CHUNK` ack: if `stop` or not `Processing`, reset to `Pending`; if `offset < metaData.size`, send the next chunk; else status → `Success` and toast. [`repo://src/components/sender/Sender.svelte#L46-L72`]
5. `REJECT` / `VALIDATE_ERROR`: set the error, toast, status → `Pending` (retryable via re-send).

Chunking: `sendNextChunk` slices `file.slice(offset, offset + chunkBytes)`, reads it as an `ArrayBuffer`, encrypts it (when `isEncrypt` and `aesKey` present), and frames it as a `Message`. The chunk size is **defensively coerced to a number at the slice site** (`Number(chunkSize)` with a 32 KB fallback for non-finite or non-positive values), because a Svelte 5 `<select> bind:value` yields the DOM option value as a **string** — and a string here makes `offset + chunkSize` concatenate instead of add, sending the whole file remainder as one over-sized chunk. The sender options UI also coerces on change: `OfferOptions.onChange` `Number()`s the select value and falls back to `DEFAULT_SEND_OPTIONS.chunkSize` when it is not in `CHUNK_SIZE_OPTIONS`, keeping `sendOptions.chunkSize` a number at the source. [`repo://src/components/sender/Sender.svelte#L109-L117`], [`repo://src/components/OfferOptions.svelte#L19-L30`], [`repo://tests/sender-chunk-size.test.mjs`]

**Empty-chunk guard:** if `buffer.byteLength === 0` while `offset < size`, the chunk size is invalid (e.g. a crafted `c` URL param producing NaN/0); the sender aborts with an "Invalid chunk size" error instead of looping forever on zero-byte sends. [`repo://src/components/sender/Sender.svelte#L120-L128`]

Progress: computed as `offset/size * 100`; the reactive `progress` and `bitrate` are only updated every `PROGRESS_UPDATE_UI_STEP` (3) points using a non-reactive `fileStats` mirror — throttling UI updates during fast transfers. Pause/resume is the `stop` flag plus `onContinue`, which re-emits a synthetic `RECEIVED_CHUNK` to restart the loop. [`repo://src/components/sender/Sender.svelte#L34-L41`], [`repo://src/configs.ts#L65-L67`], [`repo://src/components/sender/Sender.svelte#L182-L185`]

## Receiver state machine

`receivingFiles` is a reactive map; per-file chunk accumulation (`receivingFileChunkMap`), byte/progress counters (`receivingFileStatsMap`), and the per-file processing chains (`chunkQueue`) are **deliberately non-reactive** plain objects to avoid re-rendering per chunk. [`repo://src/components/receiver/Receiver.svelte#L25-L35`], [`repo://src/components/receiver/Receiver.svelte#L88-L91`]

`onMetaData(id, metaData)`:

1. **Register the file entry at `WaitingAccept` first** — before any async work — so the file is visible (and removable) throughout; chunk processing stays safe because the chunk map only exists after the file is accepted.
2. If `isEncrypt && rsa`, unwrap `metaData.key` with the private RSA key into the file's `aesKey` — inside a `try/catch`: on failure the entry gets a visible `error` ("Failed to decrypt the file key"), an error toast fires, and the handler returns without accepting (previously a key-unwrap failure meant the file silently never appeared and the sender waited for an accept that would never come).
3. Validate via `validateFileMetadata(metaData, receiveOptions.maxSize)` (default max 1 GB); on failure send `EVENT_VALIDATE_ERROR`, store the error, and stop.
4. If `autoAccept` (default on), immediately `onAccept(id)` — send `EVENT_RECEIVER_ACCEPT`, set `Processing`, and initialize the chunk/stats maps. Manual accept/deny is also available via the list UI. [`repo://src/components/receiver/Receiver.svelte#L37-L86`], [`repo://src/configs.ts#L30-L33`]

`onChunkData(id, chunk)` is now **synchronous**:

1. **Guard**: drop the chunk for unknown or uninitialized file ids (metadata never registered, file removed/denied, or file already completed) instead of throwing on a missing entry inside queued processing.
2. **Enqueue onto the per-file promise chain** via `serializeTask(chunkQueue, id, …)` (`src/utils/serialize.ts`): `processChunk` for chunk N+1 cannot start before chunk N's processing has settled, so the post-await work — decrypt, push to `receivedChunks`, stats, blob-on-complete — runs strictly in arrival order even when WebCrypto `decryptAesGcm` calls complete out of order (which is what silently corrupted encrypted files before this fix). The chain's `catch` routes any error to `rejectCorruptChunk` (idempotent — no-op once the file's chunk map is gone) instead of silently swallowing it, so a failed chunk can never leave the file permanently incomplete. [`repo://src/components/receiver/Receiver.svelte#L93-L116`], [`repo://src/utils/serialize.ts#L1-L20`]

`processChunk(id, receivingFile, chunk)`:

1. **Decrypt first (when encryption applies), fail visibly:** a chunk that fails AES-GCM auth routes to `rejectCorruptChunk` — it marks the file errored, bounces the status back to `Pending`, toasts the failure, sends `EVENT_RECEIVER_REJECT` so the sender stops cleanly instead of waiting for acks forever, and tears down the per-file chunk/stats/queue state — instead of the chunk being silently dropped and the byte count never reaching the total, which would have left the file in `Processing` forever (PR #54).
2. **Re-check the chunk map**: if the file was removed/denied/rejected while this chunk was in flight, drop the result without acking (an ack would advance the sender past a rejected file).
3. **Immediately** send `EVENT_RECEIVED_CHUNK` — the sender's next chunk only flows after this ack, which paces the transfer (backpressure). The ack is sent **only after successful decryption**, so a corrupt chunk never advances the sender.
4. Append the plaintext buffer to `receivedChunks`, bump `receivedSize` and throttled progress/bitrate (same 3-point step).
5. When `receivedSize >= metaData.size`: build the file `Blob` **immediately and delete both per-file maps** — this releases the raw per-chunk buffers so a large file is not held twice in memory — then status → `Success`, toast, and release the file's `chunkQueue` entry. [`repo://src/components/receiver/Receiver.svelte#L118-L192`], [`repo://src/components/receiver/Receiver.svelte#L194-L225`]

Removal/deny sends `EVENT_RECEIVER_REJECT` (if not already successful) and drops the file's state maps **and its `chunkQueue` entry** (likewise cleared in `onAccept` for re-accept, and by `rejectCorruptChunk` on a corrupt chunk). [`repo://src/components/receiver/Receiver.svelte#L227-L245`], [`repo://src/components/receiver/Receiver.svelte#L288-L300`]

## Downloading received files

Single-file and bulk download both route through `triggerDownload`, which creates an object URL, clicks a temporary `<a download>`, and **defers `URL.revokeObjectURL` ~1 s** — revoking in the same tick can abort the async download in some engines (Firefox may start the fetch after the revoke). [`repo://src/components/receiver/Receiver.svelte#L243-L253`]

"Download all files (zip)" no longer triggers sequential per-file raw downloads (which browsers block after the first, and which never produced a zip despite the label): it collects all `Success` files without errors and builds a **real store-only ZIP archive in memory** via `createZipStoreOnly` (`src/utils/zip.ts`, no new dependency — a hand-rolled uncompressed/method-0 writer with CRC-32, UTF-8 name flag, and duplicate-name disambiguation), saving a single `zero-share-files.zip`. [`repo://src/components/receiver/Receiver.svelte#L302-L323`], [`repo://src/utils/zip.ts#L1-L122`]

## Validation & user-facing errors

`validateFileMetadata` is the single size gate (returns an `Error` with a `humanFileSize`-rendered limit message; undefined when OK). Sender-side validation runs at pick time without a limit; receiver-side enforces `maxSize` in `onMetaData` after key handling. Errors surface through the nanostores `toastAtom` via `addToastMessage`, which both components import. [`repo://src/utils/validator.ts#L1-L8`], [`repo://src/components/receiver/Receiver.svelte#L67-L81`], [`repo://src/stores/toastStore.ts`]

**Max Size options must be true byte values (PR #44).** `ReceiverOptions.svelte`'s "Max Size" dropdown options used to carry values 1024x smaller than their labels — "10 MB" was `10 * 1024` (10 KB), so selecting it rejected nearly every real file. The options now carry the values their labels mean: 10 MB → `10 * 1024 * 1024`, 100 MB → `100 * 1024 * 1024`, 1 GB, 10 GB, and "Unlimit" → 1 TiB (`DEFAULT_RECEIVE_OPTIONS.maxSize` stays 1 GB when nothing is selected). A second, silent bug was fixed in the same pass: `bind:value` on a `<select>` yields the DOM option value as a **string** after user interaction, and the raw string broke `humanFileSize` rendering (`Number.isFinite` fails → "0 B" in error toasts); `onChange` therefore coerces with `Number(maxSize)` and falls back to `DEFAULT_RECEIVE_OPTIONS.maxSize` when the parse is not finite, keeping `ReceiveOptions.maxSize` a number at runtime. [`repo://src/components/receiver/ReceiverOptions.svelte#L16-L23`], [`repo://src/components/receiver/ReceiverOptions.svelte#L44-L51`]

## Invariants & failure behavior

- **Chunk order is protocol- and runtime-enforced, not channel-ordered**: the data channel is created `ordered: false`; correctness now rests on two layers — the single-writer sender loop per file (one `RECEIVED_CHUNK` → one chunk, sender stays one round-trip ahead) AND the receiver's per-file promise-chain serialization (`serializeTask`), which guarantees receiver-side assembly happens in strict arrival order even when WebCrypto decrypt completions are out of order. [`repo://src/components/OfferPage.svelte#L100-L102`], [`repo://src/utils/serialize.ts#L1-L20`], [`repo://src/components/receiver/Receiver.svelte#L88-L116`]
- A receiver ack for a stopped/idle file resets the sender file to `Pending` with progress 0 rather than erroring.
- **Late/stray chunks are dropped, not fatal**: chunks for unknown/uninitialized file ids are ignored at the `onChunkData` guard, and `processChunk` re-checks the chunk map after the decrypt await (a file may be removed/denied mid-flight) — but a chunk that fails decryption is **not** dropped: it rejects the whole file visibly via `rejectCorruptChunk` (error + `Pending` + `EVENT_RECEIVER_REJECT` + per-file state teardown), because without retransmission a missing byte can never make the file complete. [`repo://src/components/receiver/Receiver.svelte#L93-L116`], [`repo://src/components/receiver/Receiver.svelte#L118-L144`], [`repo://src/components/receiver/Receiver.svelte#L194-L225`]
- Completion is exact-size based: both sides stop when the declared `metaData.size` is fully sent/received; there is no file trailer or checksum, so integrity relies on GCM authentication (encryption on) or DTLS data integrity.
- **`MetaData.size` is `int64` on the wire** (PR #42 / commit 721c502; was `int32`): the widened field means files of 2 GiB or larger no longer throw `invalid int32` during `Message.encode`, so the exact-size completion invariant now holds for arbitrarily large files (up to JS's safe-integer limit) rather than only below the 2 GiB `int32` ceiling. [`repo://src/proto/message.proto#L1-L8`], [`repo://tests/protocol-size.test.mjs#L33-L52`]
- **Regression coverage**: `npm test` runs **all** `tests/*.test.mjs` (16 guards) via `node --no-warnings --test "tests/*.test.mjs"`. `tests/receiver-chunk-order.test.mjs` drives `serializeTask` exactly as `onChunkData` wires it (mocked decrypt resolving the first chunk slowest) and asserts strict arrival-order assembly; `tests/receiver-chunk-failure.test.mjs` pins the corrupt-chunk path — a chunk failing AES-GCM auth must surface an error, bounce the file to `Pending`, send `EVENT_RECEIVER_REJECT`, and never leave the file in `Processing`; `tests/sender-chunk-size.test.mjs` pins numeric chunk-size handling end-to-end (string select values coerced, no over-sized remainder chunk); `tests/zip.test.mjs` checks CRC-32 vectors and round-trips `createZipStoreOnly` output through an external unzip; `tests/protocol-size.test.mjs` pins the `int64` `MetaData.size` wire encoding by encoding and round-tripping 3 GiB and `MAX_SAFE_INTEGER` sizes through the generated proto; `tests/receiver-options-size.test.mjs` (PR #44) statically asserts every "Max Size" `<option value={...}>label</option>` pair carries the byte value its label names, the "Unlimit" option is 1 TiB, and `onChange` coerces the select value to a number before emitting `ReceiveOptions.maxSize`; `tests/drag-drop-paste.test.mjs` pins the paste-listener scoping (text-field targets ignored). [`repo://tests/receiver-chunk-order.test.mjs`], [`repo://tests/receiver-chunk-failure.test.mjs`], [`repo://tests/sender-chunk-size.test.mjs`], [`repo://tests/zip.test.mjs`], [`repo://tests/protocol-size.test.mjs`], [`repo://tests/receiver-options-size.test.mjs`], [`repo://tests/drag-drop-paste.test.mjs`]
