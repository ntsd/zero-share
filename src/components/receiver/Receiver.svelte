<script lang="ts">
  import {
    DEFAULT_RECEIVE_OPTIONS,
    MAX_INCOMING_FILES,
    MAX_TOTAL_RECEIVED_BYTES,
    PROGRESS_UPDATE_UI_STEP
  } from '../../configs';
  import { addToastMessage } from '../../stores/toastStore';
  import { validateFileMetadata } from '../../utils/validator';
  import { humanFileSize } from '../../utils/humanFileSize';
  import { Message, MetaData, ReceiveEvent } from '../../proto/message';
  import ReceivingFileList from './ReceivingFileList.svelte';
  import ReceiverOptions from './ReceiverOptions.svelte';
  import {
    FileStatus,
    type ReceiveOptions,
    type FileDetail,
    type ReceivingFileChunks,
    type ReceivingFileStats
  } from '../../type';
  import { decryptAesGcm, decryptAesKeyWithRsaPrivateKey } from '../../utils/crypto';
  import { createChannelSender } from '../../utils/channelSender';
  import { createZipStoreOnly, sanitizeName } from '../../utils/zip';
  import { serializeTask } from '../../utils/serialize';

  type Props = {
    dataChannel: RTCDataChannel;
    isEncrypt: boolean;
    rsa: CryptoKeyPair | undefined;
  };

  let { dataChannel, isEncrypt, rsa }: Props = $props();

  let receiveOptions: ReceiveOptions = $state(DEFAULT_RECEIVE_OPTIONS);
  let receivingFiles: { [key: string]: FileDetail } = $state({});
  // non state map to track receiving file part chunks
  const receivingFileChunkMap: {
    [fileId: string]: ReceivingFileChunks;
  } = {};
  const receivingFileStatsMap: {
    [fileId: string]: ReceivingFileStats;
  } = {};
  // Per-file attempt generation: re-offers of a still-active file bump it, so
  // acks and chunk pushes that were in flight for an older attempt (their
  // serializeTask continuations survive a `delete chunkQueue[id]`) are dropped
  // instead of landing on the new attempt's chunk map (double-counted
  // receivedSize -> early completion with a truncated Blob). The chunk map is
  // the single source of truth; this is the generation guard that fences
  // post-await continuations that captured the old map reference.
  const receivingFileGeneration: { [fileId: string]: number } = {};

  export async function onMetaData(id: string, metaData: MetaData) {
    // Sanitize the peer-controlled name at ingestion — one rule covering all
    // sinks. MetaData.name arrives on the wire from the remote side; the raw
    // value is the sole source of path-traversal / zip-slip (CWE-22). A peer
    // that names a file "a/b/../../../../etc/passwd" would otherwise land
    // verbatim in the "Download all files (zip)" archive (createZipStoreOnly,
    // the primary exploitable sink) and in <a download> (triggerDownload).
    // sanitizeName() keeps only a safe basename; createZipStoreOnly()
    // re-sanitizes as defense in depth.
    metaData.name = sanitizeName(metaData.name);

    const existing = receivingFiles[id];
    if (existing && existing.status === FileStatus.Success) {
      // Terminal: the sender's Resend button only exists for failed files, and
      // a fresh file pick gets a fresh id, so a metadata frame for a completed
      // id is stale/duplicate. Ignore it instead of clobbering the Success
      // entry (blob, status) with a fresh WaitingAccept that would never
      // receive chunks. (This check runs before the admission caps so a
      // completed id is never subject to — or counted toward — them.)
      return;
    }

    // Admission cap against peer-driven resource exhaustion: a live channel
    // can stream an unbounded sequence of metadata frames, and with
    // autoAccept (default) every one is accepted without any user action —
    // each growing the receiving list, the per-file chunk maps, the toast
    // list, and on completion retaining a Blob of the whole file. Before
    // registering a NEW entry, count the active (non-Success) entries and
    // the total declared size of every not-yet-removed entry (active and
    // completed alike — a completed entry's Blob is exactly its declared
    // size, per the exact-match completion gate, and it stays resident
    // until the user removes it); a frame that would push either past its
    // cap is NOT registered: the guarded send() rejects it back to the
    // sender (whose handler bounces the file to Pending with an error, the
    // same recovery as every other reject path) and ONE error toast — a
    // per-file toast per rejected frame would itself be the unbounded toast
    // fan-out this cap exists to stop.
    //
    // The frame's own id is excluded from both counts: a re-offer of an
    // already-held file resets the SAME entry (no new registration), so it
    // must never count against the caps and be rejected by itself.
    const otherEntries = Object.keys(receivingFiles)
      .filter((key) => key !== id)
      .map((key) => receivingFiles[key]);
    if (otherEntries.filter((f) => f.status !== FileStatus.Success).length >= MAX_INCOMING_FILES) {
      addToastMessage(
        `Too many files being received — ${metaData.name} was rejected (limit ${MAX_INCOMING_FILES} active files)`,
        'error'
      );
      send(
        Message.encode({
          id: id,
          receiveEvent: ReceiveEvent.EVENT_RECEIVER_REJECT
        }).finish()
      );
      return;
    }
    const totalReceivedBytes = otherEntries.reduce((sum, f) => sum + f.metaData.size, 0);
    if (totalReceivedBytes + metaData.size > MAX_TOTAL_RECEIVED_BYTES) {
      addToastMessage(
        `Too many bytes being received — ${metaData.name} was rejected (total limit ${humanFileSize(MAX_TOTAL_RECEIVED_BYTES)})`,
        'error'
      );
      send(
        Message.encode({
          id: id,
          receiveEvent: ReceiveEvent.EVENT_RECEIVER_REJECT
        }).finish()
      );
      return;
    }

    // Re-offer of a file we still hold (the sender's Resend button re-sends the
    // same metadata for the same id after a failed first attempt). A
    // SUCCESSFUL entry is terminal — never clobber it. Every other existing
    // entry is reset; when the previous attempt is still actively receiving
    // (chunk map present), two more things must happen first:
    //   - send EVENT_RECEIVER_REJECT so the sender's still-running pipeline
    //     stops cleanly,
    //   - bump the per-file generation, so in-flight serializeTask
    //     continuations from the old attempt (their .then runs even after its
    //     key is deleted from chunkQueue) are DROPPED by processChunk /
    //     rejectCorruptChunk instead of landing on the NEW attempt's chunk map
    //     — where they would double-count receivedSize and fire the completion
    //     gate early (truncated Blob marked Success).
    // For the already-failed case (Pending + error, no chunk map) the old
    // pipeline is already dead: tear down silently WITHOUT rejecting — there
    // is no live attempt to abort, and the reject would only add a "Receiver
    // reject the file" toast around a resend that is about to be accepted.
    if (existing) {
      if (receivingFileChunkMap[id]) {
        // Guarded send (same convention as every other reject path): on a
        // live channel this reject reaches the sender's still-running pipeline
        // and stops it cleanly; if the channel is already closing it no-ops
        // instead of throwing an InvalidStateError out of onMetaData.
        send(
          Message.encode({
            id: id,
            receiveEvent: ReceiveEvent.EVENT_RECEIVER_REJECT
          }).finish()
        );
        addToastMessage(`Retrying ${metaData.name}: previous transfer aborted`, 'info');
      }
      receivingFileGeneration[id] = (receivingFileGeneration[id] ?? 0) + 1;
      delete receivingFileChunkMap[id];
      delete receivingFileStatsMap[id];
      delete chunkQueue[id];
    }

    // Register the file entry before the async key decryption so the file is
    // visible (and removable) throughout; chunk processing stays safe because
    // the chunk map only exists after the file is accepted.
    receivingFiles[id] = {
      metaData: metaData,
      progress: 0,
      bitrate: 0,
      startTime: 0,
      status: FileStatus.WaitingAccept
    };

    let aesKey: CryptoKey | undefined;
    if (isEncrypt && rsa) {
      try {
        aesKey = await decryptAesKeyWithRsaPrivateKey(
          rsa.privateKey,
          metaData.key as Uint8Array<ArrayBuffer>
        );
      } catch {
        // Key decryption failed: mark the entry so it can be seen and removed,
        // AND signal the sender. Every other onMetaData failure path (validateErr
        // above, onRemove/onDeny/rejectCorruptChunk below) sends a receive event
        // back over the channel; this path was the only one that omitted it, so
        // the sender's file sat in WaitingAccept forever with no exit — its only
        // transitions are peer-driven, and no accept will ever come for a key it
        // cannot decrypt. Send EVENT_VALIDATE_ERROR (the metadata key failed to
        // process) so the sender bounces to Pending and re-offers the file.
        // The entry is removable during the decryption await above (Deny is
        // live on WaitingAccept entries — post-#76 the UI offers Accept/Deny
        // there), so re-read and null-guard it before the error write: a
        // Deny landed in that window left `receivingFiles[id]` undefined and
        // the unguarded write threw an unhandled TypeError rejection instead
        // of cleanly skipping the removed file.
        const metaEntry = receivingFiles[id];
        if (!metaEntry) return; // denied/removed during the decryption window
        metaEntry.error = new Error('Failed to decrypt the file key');
        addToastMessage(`${metaData.name} failed to decrypt the file key`, 'error');

        send(
          Message.encode({
            id: id,
            receiveEvent: ReceiveEvent.EVENT_VALIDATE_ERROR
          }).finish()
        );

        return;
      }
    }
    // The entry is removable during the key-decryption await above (Remove is
    // live on WaitingAccept entries), so re-read and null-guard it before the
    // post-await assignment — an unguarded `receivingFiles[id].aesKey` throws
    // an unhandled TypeError rejection if Remove landed in that window.
    const entry = receivingFiles[id];
    if (!entry) return; // removed during the decryption window
    entry.aesKey = aesKey;

    const validateErr = validateFileMetadata(metaData, receiveOptions.maxSize);
    if (validateErr) {
      addToastMessage(`${metaData.name} ${validateErr.message}`, 'error');

      send(
        Message.encode({
          id: id,
          receiveEvent: ReceiveEvent.EVENT_VALIDATE_ERROR
        }).finish()
      );

      receivingFiles[id].error = validateErr;

      return;
    }

    if (receiveOptions.autoAccept) {
      onAccept(id);
    }
  }

  // non state per-file promise chains: serialize chunk processing so the
  // post-await work (decrypt, push, stats, blob on complete) runs strictly in
  // arrival order, even when WebCrypto decrypt calls complete out of order
  const chunkQueue: { [fileId: string]: Promise<unknown> } = {};

  // The guarded channel send (dead-channel flag + readyState check + throwing
  // send catch) lives in the shared src/utils/channelSender.ts helper,
  // deduplicated from the sender's identical copy — see that file for the
  // full rationale.
  const channelSender = createChannelSender(dataChannel);
  // Call sites keep their plain send(...) shape; only the implementation
  // moved into the helper.
  const { send } = channelSender;

  // Fired by the owning page's dataChannel onclose/onerror: mark every file
  // that cannot complete any more with an accurate "connection lost" error
  // (a single toast, not one false per-chunk error per in-flight chunk) and
  // tear down the per-file chunk state so queued chunks are dropped by
  // onChunkData instead of re-entering processChunk.
  export function onChannelClose() {
    if (channelSender.isLost()) return;
    channelSender.markLost();
    for (const id of Object.keys(receivingFiles)) {
      const f = receivingFiles[id];
      if (f.status === FileStatus.Success) continue; // its blob is complete
      f.error = new Error('Connection lost — transfer aborted');
      f.status = FileStatus.Pending;
      addToastMessage(`${f.metaData.name}: connection lost — transfer aborted`, 'error');
    }
    for (const id of Object.keys(receivingFileChunkMap)) {
      delete receivingFileChunkMap[id];
      delete receivingFileStatsMap[id];
      delete chunkQueue[id];
      delete receivingFileGeneration[id];
    }
  }

  export function onChunkData(id: string, chunk: Uint8Array<ArrayBuffer>) {
    // Drop chunks for unknown or uninitialized files (metadata never registered,
    // file removed/denied, or file already completed) instead of throwing on a
    // missing entry inside the queued processing.
    const receivingFile = receivingFiles[id];
    if (!receivingFile || !receivingFileChunkMap[id]) {
      return;
    }

    // Enqueue onto the per-file chain: processChunk for chunk N+1 cannot start
    // before chunk N's processing has settled, so the ack is still sent in
    // arrival order (sender stays one round-trip ahead) and the decrypted
    // chunks are pushed in the exact order they were received.
    //
    // Capture this attempt's generation NOW (pre-await): a re-offer of this
    // file bumps it, so a chunk enqueued by a previous attempt's pipeline is
    // dropped instead of landing on the recreated chunk map (its bytes belong
    // to an attempt the sender is no longer streaming — counting them would
    // advance the new attempt and double-count receivedSize).
    const generation = receivingFileGeneration[id] ?? 0;
    serializeTask(chunkQueue, id, () => processChunk(id, receivingFile, chunk, generation)).catch(
      () => {
        // A chunk that failed (e.g. corrupt chunk failing AES-GCM auth) is
        // handled inside processChunk via rejectCorruptChunk; that path resolves
        // (returns), so it never reaches here. This catch is the safety net for
        // any unexpected error that would otherwise leave the file permanently
        // incomplete: surface it the same way instead of swallowing it silently.
        // rejectCorruptChunk is a no-op once the per-file chunk map is gone, so
        // it will not double-fire.
        rejectCorruptChunk(id, receivingFile, generation);
      }
    );
  }

  async function processChunk(
    id: string,
    receivingFile: FileDetail,
    chunk: Uint8Array<ArrayBuffer>,
    generation: number
  ) {
    // This chunk was enqueued by a previous attempt of this file (its re-offer
    // bumped the generation and recreated the chunk map): drop it without
    // decrypting/acking — acking would advance the sender past a chunk the NEW
    // attempt already sent, desynchronizing the re-transfer.
    if ((receivingFileGeneration[id] ?? 0) !== generation) {
      return;
    }

    let arrayBuffer = chunk;

    if (isEncrypt && receivingFile.aesKey) {
      try {
        arrayBuffer = await decryptAesGcm(receivingFile.aesKey, arrayBuffer);
      } catch {
        // A corrupt chunk is never retransmitted (one-shot streaming), so the
        // byte count can never catch up to the total. Surface the error and
        // reject the file so the sender stops cleanly instead of leaving it
        // stuck in Processing forever.
        rejectCorruptChunk(id, receivingFile, generation);
        return;
      }
    }

    // The file may have been removed/denied/rejected while this chunk was in
    // flight; the chunk map is cleaned up at that point, so drop the result
    // without acking (an ack would advance the sender past a rejected file).
    const chunkMap = receivingFileChunkMap[id];
    if (!chunkMap) {
      return;
    }

    // Re-check the generation AFTER the decrypt await (the pre-decrypt check
    // only avoids wasted work): a re-offer may have bumped it while this chunk
    // was suspended in the decrypt, and the chunk map above is then the NEW
    // attempt's. An ack/push from this stale chunk would advance and
    // double-count the new attempt (whose sender already re-streamed these
    // bytes) — drop it instead of landing on the new map.
    if ((receivingFileGeneration[id] ?? 0) !== generation) {
      return;
    }

    // The ack is sent only after successful decryption (and after confirming
    // the file is still active), so a corrupt chunk does not advance the
    // sender past a chunk it cannot use. On a dead channel send() silently
    // fails — the file has already been marked "connection lost" by
    // onChannelClose(), so no per-chunk error may fire for chunks that only
    // failed because the channel closed mid-transfer.
    send(
      Message.encode({
        id: id,
        receiveEvent: ReceiveEvent.EVENT_RECEIVED_CHUNK
      }).finish()
    );

    const receivingSize = arrayBuffer.byteLength;
    chunkMap.receivedChunks.push(arrayBuffer);
    receivingFileStatsMap[id].receivedSize += receivingSize;

    // calculate progress — clamp to [0, 100]: a peer that claims a size
    // smaller than the payload it actually streams pushes the ratio past 100
    // until the overshoot reject below fires (NaN is coerced to 0 as a safe
    // fallback). The clamp is defense in depth on top of the exact-match
    // gate: never hand the UI a progress value it cannot render sensibly.
    const rawProgress = Math.round(
      (receivingFileStatsMap[id].receivedSize / receivingFile.metaData.size) * 100
    );
    receivingFileStatsMap[id].progress = Math.min(
      100,
      Math.max(0, Number.isNaN(rawProgress) ? 0 : rawProgress)
    );
    if (receivingFileStatsMap[id].progress >= receivingFileStatsMap[id].nextProgressUpdate) {
      // update UI
      receivingFiles[id].progress = receivingFileStatsMap[id].progress;
      // calculate bitrate and update UI
      // Floor the elapsed time to 1 ms: a small file whose accept and first
      // acked chunk settle in the same millisecond makes the raw denominator
      // 0, and bytes / 0 is Infinity (or NaN) — a value that would be stored
      // in $state and render as a misleading "0 B/sec".
      const elapsedMs = Math.max(1, Date.now() - receivingFiles[id].startTime);
      receivingFiles[id].bitrate = Math.round(
        receivingFileStatsMap[id].receivedSize / (elapsedMs / 1000)
      );
      // schedule next update
      receivingFileStatsMap[id].nextProgressUpdate += PROGRESS_UPDATE_UI_STEP;
      if (receivingFileStatsMap[id].nextProgressUpdate > 100) {
        receivingFileStatsMap[id].nextProgressUpdate = 100;
      }
    }

    if (receivingFileStatsMap[id].receivedSize === receivingFile.metaData.size) {
      // Complete ONLY on an exact byte count. metaData.size is peer-controlled
      // and already lower-bound validated, but the validator cannot bound the
      // payload against the size: a peer that claims a size smaller than the
      // payload it actually streams is corrupt, and finishing on the first
      // chunk that reached the claim would mark a silently truncated prefix as
      // Success while the stream tail is dropped on both ends.
      // Build the Blob immediately so the raw per-chunk buffers can be released;
      // holding them would keep the entire received file resident in memory.
      receivingFiles[id].blob = new Blob(receivingFileChunkMap[id].receivedChunks, {
        type: receivingFile.metaData.type
      });
      delete receivingFileChunkMap[id];
      delete receivingFileStatsMap[id];
      receivingFiles[id].status = FileStatus.Success;
      addToastMessage(`Received ${receivingFiles[id].metaData.name}`, 'success');
      // No more chunks will arrive for this file; release the chain entry.
      delete chunkQueue[id];
      // The entry is terminal Success (a Success re-offer is ignored), so the
      // generation can never matter again — release it with the rest.
      delete receivingFileGeneration[id];
    } else if (receivingFileStatsMap[id].receivedSize > receivingFile.metaData.size) {
      // Overshoot: this chunk pushed the received byte count PAST the declared
      // size, so the peer's declared size is a lie (truncated file on the wire).
      // Reject the whole file instead of assembling a prefix.
      rejectOversizedStream(id, receivingFile, receivingFileStatsMap[id].receivedSize);
    }
  }

  // Shared reject teardown for the reject paths (oversized stream, corrupt
  // chunk): no-op if the file is no longer being actively received (removed,
  // denied, or already rejected) — the per-file chunk map is the source of
  // truth. Otherwise mark the entry errored, bounce the status back to
  // Pending (so the error is visible and the file can be removed/retried),
  // toast, and reject so the sender bounces to Pending instead of reporting a
  // "successful" transfer.
  //
  // Guarded send: on a live channel this reject reaches the sender; if the
  // channel just died, send() no-ops instead of throwing again (the queued
  // continuation that calls us would otherwise leave an unhandled rejection
  // and skip the teardown below).
  //
  // Tear down per-file chunk state so in-flight chunks for this file are
  // dropped (their processing hits the removed chunk map) and the file does
  // not linger in a half-received Processing state.
  // The error/status mutations above go through the same $state proxy as
  // receivingFiles[id], so the UI already updates from them — no extra
  // assignment needed.
  function rejectFile(id: string, receivingFile: FileDetail, error: Error, toastMessage: string) {
    if (!receivingFileChunkMap[id]) {
      return;
    }
    receivingFile.error = error;
    receivingFile.status = FileStatus.Pending;
    addToastMessage(toastMessage, 'error');
    send(
      Message.encode({
        id,
        receiveEvent: ReceiveEvent.EVENT_RECEIVER_REJECT
      }).finish()
    );
    delete receivingFileChunkMap[id];
    delete receivingFileStatsMap[id];
    delete chunkQueue[id];
    delete receivingFileGeneration[id];
  }

  // The peer streamed more bytes than its declared metaData.size: the
  // declared size is a lie, so the only bytes we hold are a prefix of the
  // peer's payload. Reject the whole file instead of assembling a prefix,
  // mirroring rejectCorruptChunk. Never build a Blob from the prefix.
  function rejectOversizedStream(id: string, receivingFile: FileDetail, receivedSize: number) {
    rejectFile(
      id,
      receivingFile,
      new Error(
        `peer stream did not match the declared size — file rejected: got ${receivedSize} bytes, declared ${receivingFile.metaData.size}`
      ),
      `${receivingFile.metaData.name} rejected: stream exceeded the declared size`
    );
  }

  // A chunk failed AES-GCM auth (bit-flip in transit, or a peer that claims
  // encryption but emits garbage). The sender has no retransmission, so the
  // file can never complete. Reject so the sender stops cleanly — mirroring
  // EVENT_VALIDATE_ERROR / EVENT_RECEIVER_REJECT handling on the sender side.
  //
  // Generation-fenced: a reject that belongs to a previous attempt (its
  // re-offer bumped the generation) must NOT reject the NEW attempt's chunk
  // map — that would kill the retry the user just started.
  function rejectCorruptChunk(id: string, receivingFile: FileDetail, generation: number) {
    if ((receivingFileGeneration[id] ?? 0) !== generation) {
      return;
    }
    rejectFile(
      id,
      receivingFile,
      new Error('A received chunk failed to decrypt (corrupt data in transit)'),
      `${receivingFile.metaData.name} failed: corrupt chunk (decryption error)`
    );
  }

  function onRemove(key: string) {
    // A re-entrant/duplicate click (or an entry torn down by a concurrent
    // path, e.g. onChannelClose) leaves receivingFiles[key] undefined —
    // guard it the same way the sender's onRemove does instead of throwing.
    const f = receivingFiles[key];
    if (!f) return;
    if (f.status != FileStatus.Success) {
      // Guarded: the reject is best-effort (the local state below tears down
      // regardless), and must not throw on a dead channel.
      send(
        Message.encode({
          id: key,
          receiveEvent: ReceiveEvent.EVENT_RECEIVER_REJECT
        }).finish()
      );
    }
    delete receivingFileChunkMap[key];
    delete receivingFileStatsMap[key];
    delete chunkQueue[key];
    delete receivingFileGeneration[key];
    delete receivingFiles[key];
  }

  function triggerDownload(blob: Blob, name: string) {
    // The download is async in most engines; revoking the object URL in the
    // same tick can abort it (Firefox in particular may start the fetch after
    // the revoke). Defer the revoke until the download has had time to start.
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function onDownload(key: string) {
    const receivedFile = receivingFiles[key];
    if (!receivedFile) return;
    const blobFile = receivedFile.blob;
    if (!blobFile) {
      return;
    }
    triggerDownload(blobFile, receivedFile.metaData.name);
  }

  function onAccept(id: string) {
    const receivingFile = receivingFiles[id];
    // The entry is removable between the rendered Accept button and this click
    // (onChannelClose / onRemove / onDeny can delete receivingFiles[id] in the
    // window before Svelte re-renders and hides the button). If it is gone,
    // bail before signaling ACCEPT or writing state: a removed entry must not
    // advance the sender, and writing receivingFiles[id].status on a missing
    // entry threw "Cannot set properties of undefined (setting 'status')".
    // Same null-guard convention as onChunkData / onRemove / onDownload.
    // onAccept has no top-level await, so if receivingFile is present here it
    // stays live for the whole function and the writes below are safe.
    // A second Accept click can land in the same frame as the first, before
    // Svelte re-renders the button away (onAccept flips the entry to
    // Processing only after the ACCEPT send). Without a status guard both
    // calls send EVENT_RECEIVER_ACCEPT — the sender's persistent handler
    // fires sendNextChunk() concurrently, the same chunk goes on the wire
    // twice, the byte count double-counts, and the receiver rejects a
    // fully-sent file as oversized (or never completes). The same guard also
    // covers clicks on entries that onChannelClose already bounced to Pending
    // (+error): re-accepting them would re-initialize chunk state for a file
    // that can never complete. Not actionable outside WaitingAccept, so bail
    // before the ACCEPT send and the state writes.
    if (!receivingFile || receivingFile.status !== FileStatus.WaitingAccept) {
      return;
    }
    // Refuse entries whose metadata failed (key decryption or max-size
    // validation): without a usable aesKey the transfer can never succeed —
    // on an encrypted session processChunk would skip decryption and assemble
    // the ciphertext as a Success blob, or every chunk would hit
    // rejectCorruptChunk (an N-toast storm per resend). Leave the entry in
    // WaitingAccept + error so Deny/Remove remain available (#76), and reject
    // so the sender (bounced to Pending by EVENT_VALIDATE_ERROR) does not sit
    // in WaitingAccept for a file it can never deliver.
    if (receivingFile.error || (isEncrypt && !receivingFile.aesKey)) {
      addToastMessage(
        `Cannot accept ${receivingFile?.metaData.name ?? id}: the metadata/key failed to process — the sender must resend the file`,
        'error'
      );
      send(
        Message.encode({
          id,
          receiveEvent: ReceiveEvent.EVENT_RECEIVER_REJECT
        }).finish()
      );
      return;
    }

    send(
      Message.encode({
        id,
        receiveEvent: ReceiveEvent.EVENT_RECEIVER_ACCEPT
      }).finish()
    );

    // Write through the captured reference (re-reading the map here would
    // re-introduce the unguarded-write race).
    receivingFile.status = FileStatus.Processing;
    receivingFile.startTime = Date.now();

    // initiali non state maps
    receivingFileChunkMap[id] = {
      receivedChunks: []
    };
    receivingFileStatsMap[id] = {
      progress: 0,
      startTime: Date.now(),
      nextProgressUpdate: 0,
      receivedSize: 0
    };
    delete chunkQueue[id];
  }

  function onDeny(key: string) {
    send(
      Message.encode({
        id: key,
        receiveEvent: ReceiveEvent.EVENT_RECEIVER_REJECT
      }).finish()
    );
    delete receivingFileChunkMap[key];
    delete receivingFileStatsMap[key];
    delete chunkQueue[key];
    delete receivingFileGeneration[key];
    delete receivingFiles[key];
  }

  async function downloadAllFiles() {
    const files = Object.entries(receivingFiles)
      .filter(([key]) => receivingFiles[key].status == FileStatus.Success)
      .filter(([, file]) => !file.error && file.blob)
      .map(([, file]) => ({
        name: file.metaData.name,
        data: file.blob as Blob
      }));

    // No files to download yet — nothing to do.
    if (files.length === 0) {
      return;
    }

    // A single archive: one click, one download — no browser auto-download
    // blocking (which breaks sequential per-file programmatic downloads).
    try {
      const zipBytes = await createZipStoreOnly(files);
      triggerDownload(
        new Blob([zipBytes as BlobPart], { type: 'application/zip' }),
        'zero-share-files.zip'
      );
    } catch (e) {
      // Refuse rather than ship a silently corrupt archive (e.g. an entry
      // over the 4 GiB classic-ZIP limit, which the writer throws on).
      addToastMessage(e instanceof Error ? e.message : 'Could not build the ZIP archive', 'error');
    }
  }

  function onOptionsUpdate(options: ReceiveOptions) {
    receiveOptions = options;
  }
</script>

<div class="grid gap-4">
  <ReceiverOptions onUpdate={onOptionsUpdate} />
  {#if Object.keys(receivingFiles).length > 0}
    <ReceivingFileList {receivingFiles} {onRemove} {onDownload} {onAccept} {onDeny} />
    <button class="btn btn-primary mt-2" onclick={downloadAllFiles}>Download all files (zip)</button
    >
  {:else}
    <p class="mt-4">Connected, Waiting for files...</p>
  {/if}
</div>
