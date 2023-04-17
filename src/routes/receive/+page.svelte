<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { defaultReceiveOptions, defaultSendOptions } from '../../configs';
  import { addToastMessage } from '../../stores/toastStore';
  import Eye from '../../components/Eye.svelte';
  import { validateFileMetadata } from '../../utils/validator';
  import { Message, EventMessage, ReceiverEvent } from '../../proto/message';
  import Collapse from '../../components/Collapse.svelte';
  import ReceivingFileList from '../../components/ReceivingFileList.svelte';
  import * as zip from '@zip.js/zip.js';
  import ReceiverOptions from '../../components/ReceiverOptions.svelte';
  import { FileStatus, type ReceiveOptions, type ReceivingFile } from '../../type';
  import {
    decryptAesGcm,
    decryptAesKeyWithRsaPrivateKey,
    exportRsaPublicKeyToBase64,
    generateRsaKeyPair
  } from '../../utils/crypto';
  import { sdpDecode, sdpEncode } from '../../utils/sdpEncode';
  import Spinner from '../../components/Spinner.svelte';

  let receiveOptions: ReceiveOptions = defaultReceiveOptions;
  let iceServer = defaultSendOptions.iceServer;
  let answerSDP = '';
  let showAnswerCode = false;
  let isEncrypt = defaultSendOptions.isEncrypt;
  let rsa: CryptoKeyPair;

  const sdpEncoded = $page.url.searchParams.get('sdp');
  if (sdpEncoded === null || !sdpEncoded) {
    goto('/');
    throw new Error('no sdp found');
  }

  const e2eParam = $page.url.searchParams.get('e2e');
  if (e2eParam) {
    isEncrypt = e2eParam === '1' ? true : false;
  }

  const iceServerParam = $page.url.searchParams.get('ice');
  if (iceServerParam) {
    iceServer = iceServerParam;
  }

  const connection = new RTCPeerConnection({
    iceServers: [{ urls: iceServer }]
  });
  let isConnecting = false;
  let dataChannel: RTCDataChannel;

  connection.ondatachannel = (event) => {
    dataChannel = event.channel;

    dataChannel.onopen = () => {
      addToastMessage('Connected', 'success');
      isConnecting = true;
    };
    dataChannel.onmessage = (event) => {
      handleMessage(event);
    };
    dataChannel.onerror = () => {
      addToastMessage('WebRTC error', 'error');
      isConnecting = false;
    };
    dataChannel.onclose = () => {
      addToastMessage('Disconnected', 'error');
      isConnecting = false;
    };
  };

  async function setOfferSDP(sdpEncoded: string) {
    const sdpDecoded = sdpDecode(sdpEncoded, true);
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
    addToastMessage('Copied to clipboard', 'info');
  }

  async function generateAnswerSDP() {
    let publicKeyBase64 = '';
    if (isEncrypt) {
      rsa = await generateRsaKeyPair();
      publicKeyBase64 = await exportRsaPublicKeyToBase64(rsa.publicKey);
    }

    connection.onicecandidate = (event) => {
      if (!event.candidate && connection.localDescription) {
        answerSDP = sdpEncode(connection.localDescription.sdp) + '|' + publicKeyBase64;
      }
    };

    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
  }
  generateAnswerSDP();

  // downloading
  let receivingFiles: { [key: string]: ReceivingFile } = {};

  async function handleMessage(event: MessageEvent) {
    const message = Message.decode(new Uint8Array(event.data));

    if (message.metaData) {
      let aesKey: CryptoKey | undefined;
      if (isEncrypt) {
        aesKey = await decryptAesKeyWithRsaPrivateKey(rsa.privateKey, message.metaData.key);
      }

      receivingFiles[message.id] = {
        metaData: message.metaData,
        progress: 0,
        bitrate: 0,
        receivedSize: 0,
        receivedChunks: [],
        startTime: 0,
        status: FileStatus.WaitingAccept,
        aesKey: aesKey
      };

      const validateErr = validateFileMetadata(message.metaData, receiveOptions.maxSize);
      if (validateErr) {
        addToastMessage(`${message.metaData.name} ${validateErr.message}`, 'error');

        dataChannel.send(
          EventMessage.encode({
            id: message.id,
            event: ReceiverEvent.EVENT_VALIDATE_ERROR
          }).finish()
        );

        receivingFiles[message.id].error = validateErr;

        return;
      }

      if (receiveOptions.autoAccept) {
        dataChannel.send(
          EventMessage.encode({
            id: message.id,
            event: ReceiverEvent.EVENT_RECEIVER_ACCEPT
          }).finish()
        );

        receivingFiles[message.id].status = FileStatus.Processing;
        receivingFiles[message.id].startTime = Date.now();
      }

      return;
    }

    if (message.chunk) {
      let arrayBuffer = message.chunk;

      dataChannel.send(
        EventMessage.encode({
          id: message.id,
          event: ReceiverEvent.EVENT_RECEIVED_CHUNK
        }).finish()
      );

      const receivingFile = receivingFiles[message.id];

      if (isEncrypt && receivingFile.aesKey) {
        arrayBuffer = await decryptAesGcm(receivingFile.aesKey, arrayBuffer);
      }
      const receivingSize = arrayBuffer.byteLength;

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

      if (receivingFiles[message.id].receivedSize >= receivingFile.metaData.size) {
        receivingFiles[message.id].status = FileStatus.Success;
        addToastMessage(`Received ${receivingFiles[message.id].metaData.name}`, 'success');
      }
    }
  }

  function onRemove(key: string) {
    if (receivingFiles[key].status != FileStatus.Success) {
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

  function onAccept(key: string) {
    dataChannel.send(
      EventMessage.encode({
        id: key,
        event: ReceiverEvent.EVENT_RECEIVER_ACCEPT
      }).finish()
    );

    receivingFiles[key].status = FileStatus.Processing;
    receivingFiles[key].startTime = Date.now();
  }

  function onDeny(key: string) {
    dataChannel.send(
      EventMessage.encode({
        id: key,
        event: ReceiverEvent.EVENT_RECEIVER_REJECT
      }).finish()
    );
    delete receivingFiles[key];
    receivingFiles = receivingFiles; // do this to trigger update the map
  }

  async function downloadAllFiles() {
    const zipFileWriter = new zip.BlobWriter();
    const zipWriter = new zip.ZipWriter(zipFileWriter);

    let found = false;

    for (const key of Object.keys(receivingFiles)) {
      if (receivingFiles[key].status != FileStatus.Success || receivingFiles[key].error) {
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

    addToastMessage('Not found files to download', 'error');
  }

  function onOptionsUpdate(options: ReceiveOptions) {
    receiveOptions = options;
  }
</script>

<Collapse title="1. Answer" isOpen={!isConnecting}>
  {#if answerSDP}
    <p>Copy the answer code and send to the sender to connect between peer.</p>
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
    <button class="btn btn-primary mt-2" on:click={copyAnswerCode}>Copy Answer</button>
  {:else}
    <div class="flex flex-col items-center justify-center gap-2">
      <Spinner />
      <div>Generating Answer</div>
    </div>
  {/if}
</Collapse>
<Collapse title="2. Receiving Files" isOpen={isConnecting}>
  <ReceiverOptions onUpdate={onOptionsUpdate} />
  <div class="grid gap-4 mt-2">
    {#if Object.keys(receivingFiles).length > 0}
      <ReceivingFileList {receivingFiles} {onRemove} {onDownload} {onAccept} {onDeny} />
      <button class="btn btn-primary mt-2" on:click={downloadAllFiles}
        >Download all files (zip)</button
      >
    {:else}
      <p>Connecting, waiting for files...</p>
    {/if}
  </div>
</Collapse>
