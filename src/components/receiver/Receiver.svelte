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
    let aesKey: CryptoKey | undefined;
    if (isEncrypt && rsa) {
      aesKey = await decryptAesKeyWithRsaPrivateKey(
        rsa.privateKey,
        metaData.key as Uint8Array<ArrayBuffer>
      );
    }

    receivingFiles[id] = {
      metaData: metaData,
      progress: 0,
      bitrate: 0,
      startTime: 0,
      status: FileStatus.WaitingAccept,
      aesKey: aesKey
    };

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

  export async function onChunkData(id: string, chunk: Uint8Array<ArrayBuffer>) {
    let arrayBuffer = chunk;

    dataChannel.send(
      Message.encode({
        id: id,
        receiveEvent: ReceiveEvent.EVENT_RECEIVED_CHUNK
      }).finish()
    );

    const receivingFile = receivingFiles[id];

    if (isEncrypt && receivingFile.aesKey) {
      arrayBuffer = await decryptAesGcm(receivingFile.aesKey, arrayBuffer);
    }
    const receivingSize = arrayBuffer.byteLength;

    receivingFileChunkMap[id].receivedChunks.push(arrayBuffer);
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
      receivingFiles[id].status = FileStatus.Success;
      addToastMessage(`Received ${receivingFiles[id].metaData.name}`, 'success');
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
    delete receivingFiles[key];
    receivingFiles = receivingFiles; // do this to trigger update the map
  }

  async function onDownload(key: string) {
    const receivedFile = receivingFiles[key];
    const blobFile = new Blob(receivingFileChunkMap[key].receivedChunks, {
      type: receivedFile.metaData.type
    });
    const url = URL.createObjectURL(blobFile);
    const link = document.createElement('a');
    link.href = url;
    link.download = receivedFile.metaData.name;
    link.click();
    URL.revokeObjectURL(url);
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
  }

  function onDeny(key: string) {
    dataChannel.send(
      Message.encode({
        id: key,
        receiveEvent: ReceiveEvent.EVENT_RECEIVER_REJECT
      }).finish()
    );
    delete receivingFiles[key];
    receivingFiles = receivingFiles; // do this to trigger update the map
  }

  async function downloadAllFiles() {
    for (const key of Object.keys(receivingFiles)) {
      if (receivingFiles[key].status != FileStatus.Success || receivingFiles[key].error) {
        continue;
      }
      onDownload(key);
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
