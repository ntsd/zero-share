<script lang="ts">
  import { DEFAULT_RECEIVE_OPTIONS, PROGRESS_UPDATE_UI_STEP } from '../../configs';
  import { addToastMessage } from '../../stores/toastStore';
  import { validateFileMetadata } from '../../utils/validator';
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
        receivingFiles[id].error = new Error('Failed to decrypt the file key');
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
    receivingFiles[id].aesKey = aesKey;

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
    serializeTask(chunkQueue, id, () => processChunk(id, receivingFile, chunk)).catch(() => {
      // A chunk that failed (e.g. corrupt chunk failing AES-GCM auth) is
      // handled inside processChunk via rejectCorruptChunk; that path resolves
      // (returns), so it never reaches here. This catch is the safety net for
      // any unexpected error that would otherwise leave the file permanently
      // incomplete: surface it the same way instead of swallowing it silently.
      // rejectCorruptChunk is a no-op once the per-file chunk map is gone, so
      // it will not double-fire.
      rejectCorruptChunk(id, receivingFile);
    });
  }

  async function processChunk(
    id: string,
    receivingFile: FileDetail,
    chunk: Uint8Array<ArrayBuffer>
  ) {
    let arrayBuffer = chunk;

    if (isEncrypt && receivingFile.aesKey) {
      try {
        arrayBuffer = await decryptAesGcm(receivingFile.aesKey, arrayBuffer);
      } catch {
        // A corrupt chunk is never retransmitted (one-shot streaming), so the
        // byte count can never catch up to the total. Surface the error and
        // reject the file so the sender stops cleanly instead of leaving it
        // stuck in Processing forever.
        rejectCorruptChunk(id, receivingFile);
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
      receivingFiles[id].bitrate = Math.round(
        receivingFileStatsMap[id].receivedSize /
          ((Date.now() - receivingFiles[id].startTime) / 1000)
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
  function rejectCorruptChunk(id: string, receivingFile: FileDetail) {
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
    // Refuse entries whose metadata failed (key decryption or max-size
    // validation): without a usable aesKey the transfer can never succeed —
    // on an encrypted session processChunk would skip decryption and assemble
    // the ciphertext as a Success blob, or every chunk would hit
    // rejectCorruptChunk (an N-toast storm per resend). Leave the entry in
    // WaitingAccept + error so Deny/Remove remain available (#76), and reject
    // so the sender (bounced to Pending by EVENT_VALIDATE_ERROR) does not sit
    // in WaitingAccept for a file it can never deliver.
    if (receivingFile?.error || (isEncrypt && !receivingFile?.aesKey)) {
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

    receivingFiles[id].status = FileStatus.Processing;
    receivingFiles[id].startTime = Date.now();

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
