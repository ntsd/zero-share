<script lang="ts">
  import { defaultReceiveOptions } from '../../configs';
  import { addToastMessage } from '../../stores/toastStore';
  import { validateFileMetadata } from '../../utils/validator';
  import { Message, MetaData, ReceiveEvent } from '../../proto/message';
  import ReceivingFileList from './ReceivingFileList.svelte';
  import ReceiverOptions from './ReceiverOptions.svelte';
  import { FileStatus, type ReceiveOptions, type ReceivingFile } from '../../type';
  import { decryptAesGcm, decryptAesKeyWithRsaPrivateKey } from '../../utils/crypto';

  type Props = {
    dataChannel: RTCDataChannel;
    isEncrypt: boolean;
    rsa: CryptoKeyPair | undefined;
  };

  let { dataChannel, isEncrypt, rsa }: Props = $props();

  let receiveOptions: ReceiveOptions = $state(defaultReceiveOptions);
  let receivingFiles: { [key: string]: ReceivingFile } = $state({});

  export async function onMetaData(id: string, metaData: MetaData) {
    let aesKey: CryptoKey | undefined;
    if (isEncrypt && rsa) {
      aesKey = await decryptAesKeyWithRsaPrivateKey(rsa.privateKey, metaData.key);
    }

    receivingFiles[id] = {
      metaData: metaData,
      progress: 0,
      bitrate: 0,
      receivedSize: 0,
      receivedChunks: [],
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
      dataChannel.send(
        Message.encode({
          id: id,
          receiveEvent: ReceiveEvent.EVENT_RECEIVER_ACCEPT
        }).finish()
      );

      receivingFiles[id].status = FileStatus.Processing;
      receivingFiles[id].startTime = Date.now();
    }
  }

  export async function onChunkData(id: string, chunk: Uint8Array) {
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

    receivingFiles[id].receivedChunks.push(arrayBuffer);
    receivingFiles[id].receivedSize += receivingSize;

    // calculate progress
    receivingFiles[id].progress = Math.round(
      (receivingFiles[id].receivedSize / receivingFile.metaData.size) * 100
    );

    // calculate bitrate
    receivingFiles[id].bitrate = Math.round(
      receivingFiles[id].receivedSize / ((Date.now() - receivingFiles[id].startTime) / 1000)
    );

    if (receivingFiles[id].receivedSize >= receivingFile.metaData.size) {
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
    const blobFile = new Blob(receivedFile.receivedChunks, {
      type: receivedFile.metaData.type
    });
    const url = URL.createObjectURL(blobFile);
    const link = document.createElement('a');
    link.href = url;
    link.download = receivedFile.metaData.name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function onAccept(key: string) {
    dataChannel.send(
      Message.encode({
        id: key,
        receiveEvent: ReceiveEvent.EVENT_RECEIVER_ACCEPT
      }).finish()
    );

    receivingFiles[key].status = FileStatus.Processing;
    receivingFiles[key].startTime = Date.now();
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
