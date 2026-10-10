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
  import { createZipStoreOnly } from '../../utils/zip';
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
        // Key decryption failed: mark the entry so it can be seen and removed
        // instead of the file silently never appearing and the sender waiting
        // for an accept that will not come.
        receivingFiles[id].error = new Error('Failed to decrypt the file key');
        addToastMessage(`${metaData.name} failed to decrypt the file key`, 'error');
        return;
      }
    }
    receivingFiles[id].aesKey = aesKey;

    const validateErr = validateFileMetadata(metaData, receiveOptions.maxSize);
    if (validateErr) {
      addToastMessage(`${metaData.name} ${validateErr.message}`, 'error');

      dataChannel.send(
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
      // A failed chunk (e.g. corrupt chunk failing AES-GCM auth) must not stall
      // the per-file queue; later chunks keep processing as before.
    });
  }

  async function processChunk(
    id: string,
    receivingFile: FileDetail,
    chunk: Uint8Array<ArrayBuffer>
  ) {
    let arrayBuffer = chunk;

    dataChannel.send(
      Message.encode({
        id: id,
        receiveEvent: ReceiveEvent.EVENT_RECEIVED_CHUNK
      }).finish()
    );

    if (isEncrypt && receivingFile.aesKey) {
      arrayBuffer = await decryptAesGcm(receivingFile.aesKey, arrayBuffer);
    }
    const receivingSize = arrayBuffer.byteLength;

    // The file may have been removed/denied while this chunk was in flight;
    // the chunk map is cleaned up at removal, so drop the result.
    const chunkMap = receivingFileChunkMap[id];
    if (!chunkMap) {
      return;
    }
    chunkMap.receivedChunks.push(arrayBuffer);
    receivingFileStatsMap[id].receivedSize += receivingSize;

    // calculate progress
    receivingFileStatsMap[id].progress = Math.round(
      (receivingFileStatsMap[id].receivedSize / receivingFile.metaData.size) * 100
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

    if (receivingFileStatsMap[id].receivedSize >= receivingFile.metaData.size) {
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
    }
  }

  function onRemove(key: string) {
    if (receivingFiles[key].status != FileStatus.Success) {
      dataChannel.send(
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
    receivingFiles = receivingFiles; // do this to trigger update the map
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
    const blobFile = receivedFile.blob;
    if (!blobFile) {
      return;
    }
    triggerDownload(blobFile, receivedFile.metaData.name);
  }

  function onAccept(id: string) {
    dataChannel.send(
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
    dataChannel.send(
      Message.encode({
        id: key,
        receiveEvent: ReceiveEvent.EVENT_RECEIVER_REJECT
      }).finish()
    );
    delete receivingFileChunkMap[key];
    delete receivingFileStatsMap[key];
    delete chunkQueue[key];
    delete receivingFiles[key];
    receivingFiles = receivingFiles; // do this to trigger update the map
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
    const zipBytes = await createZipStoreOnly(files);
    triggerDownload(
      new Blob([zipBytes as BlobPart], { type: 'application/zip' }),
      'zero-share-files.zip'
    );
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
