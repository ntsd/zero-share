<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { rtcConfig } from '../../configs';
  import { addToastMessage } from '../../stores/toastStore';
  import Eye from '../../components/Eye.svelte';
  import { validateFileMetadata } from '../../utils/validator';
  import { Message, EventMessage, ReceiverEvent } from '../../proto/message';
  import Collapse from '../../components/Collapse.svelte';
  import ReceivingFileList from '../../components/ReceivingFileList.svelte';
  import * as zip from '@zip.js/zip.js';

  // web rtc
  let isConnecting = false;

  const connection = new RTCPeerConnection(rtcConfig);

  let dataChannel: RTCDataChannel;

  connection.ondatachannel = (event) => {
    dataChannel = event.channel;

    dataChannel.onopen = () => {
      addToastMessage(`Connected`);
      isConnecting = true;
    };
    dataChannel.onmessage = (event) => {
      handleMessage(event);
    };
    dataChannel.onerror = () => {
      addToastMessage(`WebRTC error`);
      isConnecting = false;
    };
    dataChannel.onclose = () => {
      addToastMessage(`Disconnected`);
      isConnecting = false;
    };
  };

  let answerSDP = '';
  let showAnswerCode = false;

  const sdpEncoded = $page.url.searchParams.get('sdp');
  if (sdpEncoded === null || !sdpEncoded) {
    goto('/');
    throw new Error('no sdp found');
  }

  async function setOfferSDP(sdpEncoded: string) {
    const sdpDecoded = decodeURIComponent(sdpEncoded);
    const sessionDesc: RTCSessionDescriptionInit = {
      type: 'offer',
      sdp: sdpDecoded
    };

    await connection.setRemoteDescription(sessionDesc);
  }
  setOfferSDP(sdpEncoded);

  function toggleAnswerCodeVisibility() {
    showAnswerCode = !showAnswerCode;
  }

  async function copyAnswerCode() {
    await navigator.clipboard.writeText(answerSDP);
    addToastMessage('Copied to clipboard');
  }

  async function generateAnswerSDP() {
    connection.onicecandidate = (event) => {
      if (!event.candidate && connection.localDescription) {
        answerSDP = encodeURIComponent(connection.localDescription.sdp);
      }
    };

    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
  }
  generateAnswerSDP();

  // downloading
  let receivingFiles: { [key: string]: ReceivingFile } = {};

  function handleMessage(event: MessageEvent) {
    const message = Message.decode(new Uint8Array(event.data));

    if (message.metaData) {
      const validateErr = validateFileMetadata(message.metaData);
      if (validateErr) {
        addToastMessage(`${message.metaData.name} ${validateErr.message}`);

        dataChannel.send(
          EventMessage.encode({
            id: message.id,
            event: ReceiverEvent.EVENT_VALIDATE_ERROR
          }).finish()
        );

        return;
      }

      receivingFiles[message.id] = {
        metaData: message.metaData,
        progress: 0,
        bitrate: 0,
        processing: false,
        receivedSize: 0,
        receivedChunks: [],
        success: false,
        startTime: 0
      };

      // TODO: waiting for approve

      dataChannel.send(
        EventMessage.encode({
          id: message.id,
          event: ReceiverEvent.EVENT_RECEIVER_APPROVE
        }).finish()
      );

      receivingFiles[message.id].processing = true;
      receivingFiles[message.id].startTime = Date.now();

      return;
    }

    if (message.chunk) {
      const arrayBuffer = message.chunk;
      const receivingSize = arrayBuffer.byteLength;

      dataChannel.send(
        EventMessage.encode({
          id: message.id,
          event: ReceiverEvent.EVENT_RECEIVED_CHUNK
        }).finish()
      );

      const receivingFile = receivingFiles[message.id];
      receivingFiles[message.id].receivedChunks.push(arrayBuffer);
      receivingFiles[message.id].receivedSize += receivingSize;

      // calculate progress
      receivingFiles[message.id].progress = Math.round(
        (receivingFiles[message.id].receivedSize / receivingFile.metaData.size) * 100
      );

      // calculate bitrate
      receivingFiles[message.id].bitrate = Math.round(
        receivingFiles[message.id].receivedSize /
          ((Date.now() - receivingFiles[message.id].startTime) / 1000)
      );

      if (receivingFile.receivedSize >= receivingFile.metaData.size) {
        receivingFiles[message.id].processing = false;
        receivingFiles[message.id].success = true;
        addToastMessage(`Received ${receivingFiles[message.id].metaData.name}`);
      }
    }
  }

  function onRemove(key: string) {
    if (receivingFiles[key].processing) {
      dataChannel.send(
        EventMessage.encode({
          id: key,
          event: ReceiverEvent.EVENT_RECEIVER_REJECT
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

  async function downloadAllFiles() {
    const zipFileWriter = new zip.BlobWriter();
    const zipWriter = new zip.ZipWriter(zipFileWriter);

    let found = false;

    for (const key of Object.keys(receivingFiles)) {
      if (
        !receivingFiles[key].success ||
        receivingFiles[key].error ||
        receivingFiles[key].processing
      ) {
        continue;
      }

      const receivedFile = receivingFiles[key];
      const blobFile = new Blob(receivedFile.receivedChunks, {
        type: receivedFile.metaData.type
      });
      const name = receivedFile.metaData.name;

      const blobReader = new zip.BlobReader(blobFile);

      await zipWriter.add(name, blobReader);

      found = true;
    }

    await zipWriter.close();

    if (found) {
      const zipFileBlob = await zipFileWriter.getData();

      const url = URL.createObjectURL(zipFileBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'zero-share.zip';
      link.click();
      URL.revokeObjectURL(url);
      return;
    }

    addToastMessage('Not found files to download');
  }
</script>

<Collapse title="1. Connecting" isOpen={!isConnecting}>
  {#if answerSDP}
    <p>Copy the answer SDP and send to the sender to connect between peer.</p>
    <div class="relative mt-2">
      <input
        type={showAnswerCode ? 'text' : 'password'}
        class="input input-bordered w-full"
        value={answerSDP}
        readonly
      />
      <button class="absolute top-2 right-2 p-2" on:click={toggleAnswerCodeVisibility}>
        <Eye show={showAnswerCode} />
      </button>
    </div>
    <button class="btn btn-info mt-2" on:click={copyAnswerCode}>Copy SDP</button>
  {/if}
</Collapse>
<Collapse title="2. Receiving Files" isOpen={isConnecting}>
  <div class="grid gap-4">
    {#if Object.keys(receivingFiles).length > 0}
      <ReceivingFileList {receivingFiles} {onRemove} {onDownload} />
      <button class="btn btn-primary mt-2" on:click={downloadAllFiles}
        >Download all files (zip)</button
      >
    {:else}
      <p>Connecting, waiting for files...</p>
    {/if}
  </div>
</Collapse>
