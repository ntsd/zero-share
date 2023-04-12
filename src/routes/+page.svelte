<script lang="ts">
  import { buildURL } from '../utils/path';
  import { addToastMessage } from '../stores/toastStore';
  import { defaultSendOptions, rtcConfig } from '../configs';
  import Eye from '../components/Eye.svelte';
  import { validateFileMetadata } from '../utils/validator';
  import {
    Message,
    MetaData,
    EventMessage,
    ReceiverEvent,
    receiverEventToJSON
  } from '../proto/message';
  import DragAndDrop from '../components/DragAndDrop.svelte';
  import EventEmitter from 'eventemitter3';
  import Collapse from '../components/Collapse.svelte';
  import SendingFileList from '../components/SendingFileList.svelte';
  import SenderOptions from '../components/SenderOptions.svelte';
  import { FileStatus, type SendOptions, type SendingFile } from '../type';

  let sendOptions = defaultSendOptions;
  let isConnecting = false;

  const connection = new RTCPeerConnection(rtcConfig);

  connection.onicecandidateerror = () => {
    addToastMessage('Ice candidate error', 'error');
  };

  let dataChannel = connection.createDataChannel('data');
  dataChannel.onopen = () => {
    addToastMessage('Connected', 'success');
    isConnecting = true;
  };
  dataChannel.onmessage = (ev) => {
    handleMessage(ev);
  };
  dataChannel.onerror = () => {
    addToastMessage('WebRTC error', 'error');
    isConnecting = false;
  };
  dataChannel.onclose = () => {
    addToastMessage('Disconnected', 'error');
    isConnecting = false;
  };

  let offerLink = '';
  let showOfferLink = false;
  let answerSDP = '';

  function handleMessage(event: MessageEvent) {
    const eventData = EventMessage.decode(new Uint8Array(event.data));

    const sendingFile = sendingFiles[eventData.id];
    if (sendingFile && sendingFile.event) {
      sendingFile.event.emit(receiverEventToJSON(eventData.event));
    }
  }

  async function generateOfferLink() {
    connection.onicecandidate = (event) => {
      if (!event.candidate && connection.localDescription) {
        const sdp = connection.localDescription.sdp;
        offerLink = buildURL(location.href.split('?')[0], 'receive', {
          sdp: sdp,
          e2e: sendOptions.encryptionEnabled ? '1' : '0'
        });
      }
    };

    const offer = await connection.createOffer({
      offerToReceiveVideo: false,
      offerToReceiveAudio: false
    });
    await connection.setLocalDescription(offer);
  }

  function toggleOfferLinkVisibility() {
    showOfferLink = !showOfferLink;
  }

  async function copyOfferLink() {
    await navigator.clipboard.writeText(offerLink);
    addToastMessage('Copied to clipboard', 'info');
  }

  async function acceptAnswer() {
    const remoteDesc: RTCSessionDescriptionInit = {
      type: 'answer',
      sdp: decodeURIComponent(answerSDP)
    };
    await connection.setRemoteDescription(remoteDesc);
  }

  async function onSend(key: string) {
    const sendingFile = sendingFiles[key];
    let offset = 0;

    // reset value
    sendingFiles[key].error = undefined;
    sendingFiles[key].stop = false;

    sendingFiles[key].event = new EventEmitter();

    sendingFiles[key].event?.on(
      receiverEventToJSON(ReceiverEvent.EVENT_RECEIVER_ACCEPT),
      async () => {
        sendingFiles[key].status = FileStatus.Processing;
        sendingFiles[key].startTime = Date.now();
        await sendNextChunk();
      }
    );
    sendingFiles[key].event?.on(
      receiverEventToJSON(ReceiverEvent.EVENT_RECEIVED_CHUNK),
      async () => {
        if (sendingFiles[key].stop) {
          return;
        }
        if (sendingFiles[key].error || sendingFiles[key].status != FileStatus.Processing) {
          sendingFiles[key].progress = 0;
          sendingFiles[key].status = FileStatus.Pending;
          sendingFiles[key].stop = false;
          return;
        }

        if (offset < sendingFile.metaData.size) {
          await sendNextChunk();
          return;
        }

        sendingFiles[key].status = FileStatus.Success;
        addToastMessage(`File ${sendingFile.metaData.name} sent successfully`, 'success');
      }
    );

    sendingFiles[key].event?.on(receiverEventToJSON(ReceiverEvent.EVENT_VALIDATE_ERROR), () => {
      addToastMessage('Receiver validate error', 'error');
      sendingFiles[key].error = new Error('Receiver validate error');
      sendingFiles[key].status = FileStatus.Pending;
    });

    sendingFiles[key].event?.on(receiverEventToJSON(ReceiverEvent.EVENT_RECEIVER_REJECT), () => {
      addToastMessage('Receiver reject the file', 'error');
      sendingFiles[key].error = new Error('Receiver reject the file');
      sendingFiles[key].status = FileStatus.Pending;
    });

    function sendBuffer(buffer: ArrayBuffer) {
      dataChannel.send(
        Message.encode({
          id: sendingFile.metaData.name,
          chunk: new Uint8Array(buffer)
        }).finish()
      );
    }

    async function sendNextChunk() {
      const slice = sendingFile.file.slice(offset, offset + sendOptions.chunkSize);
      const buffer = await slice.arrayBuffer();

      sendBuffer(buffer);

      offset += buffer.byteLength;

      // calculate progress
      sendingFiles[key].progress = Math.round((offset / sendingFile.metaData.size) * 100);

      // calculate bitrate
      sendingFiles[key].bitrate = Math.round(
        offset / ((Date.now() - sendingFiles[key].startTime) / 1000)
      );
    }

    // send meta data
    dataChannel.send(
      Message.encode({
        id: sendingFile.metaData.name,
        metaData: sendingFile.metaData
      }).finish()
    );

    sendingFiles[key].status = FileStatus.WaitingAccept;
    // TODO: wait finish to send 1 by 1 file (success, error)
  }

  async function sendAllFiles() {
    for (const key of Object.keys(sendingFiles)) {
      if (sendingFiles[key].status != FileStatus.Pending || sendingFiles[key].error) {
        continue;
      }
      await onSend(key);
    }
  }

  async function onStop(key: string) {
    sendingFiles[key].stop = true;
  }

  async function onContinue(key: string) {
    sendingFiles[key].stop = false;
    sendingFiles[key].event?.emit(receiverEventToJSON(ReceiverEvent.EVENT_RECEIVED_CHUNK));
  }

  let sendingFiles: { [key: string]: SendingFile } = {};

  function onRemove(key: string) {
    if (sendingFiles[key].status === FileStatus.Processing) {
      sendingFiles[key].stop = true;
    }
    delete sendingFiles[key];
    sendingFiles = sendingFiles; // do this to trigger update the map
  }

  function onFilesPick(files: FileList) {
    Array.from(files).forEach((file) => {
      const fileMetaData: MetaData = {
        name: file.name,
        size: file.size,
        type: file.type
      };
      const validateErr = validateFileMetadata(fileMetaData);
      if (validateErr) {
        addToastMessage(`${file.name} ${validateErr.message}`, 'error');
      }

      sendingFiles[file.name] = {
        file: file,
        metaData: fileMetaData,
        progress: 0,
        bitrate: 0,
        stop: false,
        error: validateErr,
        startTime: 0,
        status: FileStatus.Pending
      };
    });
  }

  function onOptionsUpdate(options: SendOptions) {
    sendOptions = options;
  }
</script>

<Collapse title="1. Generate Offer" isOpen={!offerLink}>
  <p>Generate local SDP and build the offer link to connect with the peer.</p>
  <div class="mt-2">
    <SenderOptions onUpdate={onOptionsUpdate} />
    <button class="btn btn-primary mt-2" on:click={generateOfferLink}>Generate Offer</button>
  </div>
</Collapse>

<Collapse title="2. Accept Answer" isOpen={!isConnecting}>
  {#if offerLink}
    <p class="mt-2">Copy the offer link and send to the receiver to connect between peer.</p>
    <div class="relative mt-2">
      <input
        type={showOfferLink ? 'text' : 'password'}
        class="input input-bordered w-full"
        value={offerLink}
        readonly
      />
      <button class="absolute top-2 right-2 p-2" on:click={toggleOfferLinkVisibility}>
        <Eye show={showOfferLink} />
      </button>
    </div>
    <button class="btn btn-primary mt-2" on:click={copyOfferLink}>Copy Link</button>
  {/if}
  {#if offerLink}
    <p>Enter the Session Description Protocol (SDP) from the receiver to accept the answer.</p>
    <div class="relative mt-2">
      <input type="password" class="input input-bordered w-full" bind:value={answerSDP} />
    </div>
    <button class="btn btn-primary mt-2" on:click={acceptAnswer}>Accept Answer</button>
  {/if}
</Collapse>

<Collapse title="3. Send Files" isOpen={isConnecting}>
  <div class="grid gap-4">
    <DragAndDrop {onFilesPick} />
    {#if Object.keys(sendingFiles).length > 0}
      <SendingFileList {sendingFiles} {onRemove} {onSend} {onStop} {onContinue} />
      <button class="btn btn-primary mt-2" on:click={sendAllFiles}>Send all files</button>
    {:else}
      <p class="mt-4">No files selected</p>
    {/if}
  </div>
</Collapse>
