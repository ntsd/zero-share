<script lang="ts">
  import { pathJoin } from "../utils/path";
  import { addToastMessage } from "../stores/toastStore";
  import { chunkSize, pageDescription, rtcConfig } from "../configs";
  import Eye from "../components/Eye.svelte";
  import { validateFileMetadata } from "../utils/validator";
  import {
    Message,
    MetaData,
    EventMessage,
    ReceiverEvent,
    receiverEventToJSON,
  } from "../proto/message";
  import DragAndDrop from "../components/DragAndDrop.svelte";
  import EventEmitter from "eventemitter3";
  import Collapse from "../components/Collapse.svelte";

  // web rtc
  let isConnecting: boolean = false;

  const connection = new RTCPeerConnection(rtcConfig);

  let dataChannel = connection.createDataChannel("data");
  dataChannel.onopen = (event) => {
    addToastMessage(`Connected`);
    isConnecting = true;
  };
  dataChannel.onmessage = (event) => {
    handleMessage(event);
  };
  dataChannel.onerror = (event) => {
    addToastMessage(`WebRTC error`);
    isConnecting = false;
  };
  dataChannel.onclose = (event) => {
    addToastMessage(`Disconnected`);
    isConnecting = false;
  };

  let offerLink: string = "";
  let showOfferLink: boolean = false;
  let answerSDP: string = "";

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
        offerLink = pathJoin(
          location.href,
          `receive?sdp=${encodeURIComponent(sdp)}`
        );
      }
    };

    const offer = await connection.createOffer({
      offerToReceiveVideo: false,
      offerToReceiveAudio: false,
    });
    await connection.setLocalDescription(offer);
  }

  function toggleOfferLinkVisibility() {
    showOfferLink = !showOfferLink;
  }

  async function copyOfferLink() {
    await navigator.clipboard.writeText(offerLink);
    addToastMessage("Copied to clipboard");
  }

  async function acceptAnswer() {
    const remoteDesc: RTCSessionDescriptionInit = {
      type: "answer",
      sdp: decodeURIComponent(answerSDP),
    };
    await connection.setRemoteDescription(remoteDesc);
  }

  async function sendFile(key: string) {
    const sendingFile = sendingFiles[key];
    let offset = 0;

    sendingFiles[key].event = new EventEmitter();

    sendingFiles[key].event?.on(
      receiverEventToJSON(ReceiverEvent.EVENT_RECEIVED_METADATA),
      async (e: Event) => {
        await sendNextChunk();
      }
    );
    sendingFiles[key].event?.on(
      receiverEventToJSON(ReceiverEvent.EVENT_RECEIVED_CHUNK),
      async (e: Event) => {
        if (offset < sendingFile.metaData.size) {
          await sendNextChunk();
          return;
        }

        sendingFiles[key].success = true;
        addToastMessage(`File ${sendingFile.metaData.name} sent successfully`);
      }
    );
    sendingFiles[key].event?.on(
      receiverEventToJSON(ReceiverEvent.EVENT_VALIDATE_ERROR),
      (e: Event) => {
        addToastMessage("Receiver validate error");
      }
    );

    function sendBuffer(buffer: ArrayBuffer) {
      dataChannel.send(
        Message.encode({
          id: sendingFile.metaData.name,
          chunk: new Uint8Array(buffer),
        }).finish()
      );
    }

    async function sendNextChunk() {
      const slice = sendingFile.file.slice(offset, offset + chunkSize);
      const buffer = await slice.arrayBuffer();

      sendBuffer(buffer);

      offset += buffer.byteLength;
      sendingFiles[key].progress = Math.round(
        (offset / sendingFile.metaData.size) * 100
      );
    }

    // send meta data
    dataChannel.send(
      Message.encode({
        id: sendingFile.metaData.name,
        metaData: sendingFile.metaData,
      }).finish()
    );

    // todo wait finish (success, error)
  }

  let sendingFiles: { [key: string]: SendingFile } = {};

  function removeSelectedFile(key: string) {
    delete sendingFiles[key];
    // call this to trigger update the map
    sendingFiles = sendingFiles;
  }

  async function sendAllFiles() {
    for (const key of Object.keys(sendingFiles)) {
      if (sendingFiles[key].success || sendingFiles[key].error) {
        continue;
      }
      await sendFile(key);
    }
  }

  function handleFilesPick(files: FileList) {
    Array.from(files).forEach((file) => {
      const fileMetaData: MetaData = {
        name: file.name,
        size: file.size,
        type: file.type,
      };
      const validateErr = validateFileMetadata(fileMetaData);
      if (validateErr) {
        addToastMessage(`${file.name} ${validateErr.message}`);
      }

      sendingFiles[file.name] = {
        file: file,
        metaData: fileMetaData,
        progress: 0,
        success: false,
        error: validateErr,
      };
    });
  }
</script>

<svelte:head>
  <title>Zero Share: Sender</title>
  <meta name="description" content={pageDescription} />
</svelte:head>

<Collapse title="Generate" isOpen={true}>
  <button class="btn btn-primary" on:click={generateOfferLink}>
    Generate Offer Link
  </button>
</Collapse>

{#if offerLink}
  <div class="mt-4">
    <div class="label">
      <span class="label-text">Offer link:</span>
    </div>
    <div class="relative">
      <input
        type={showOfferLink ? "text" : "password"}
        class="input input-bordered w-full"
        value={offerLink}
        readonly
      />
      <button
        class="absolute top-2 right-2 p-2"
        on:click={toggleOfferLinkVisibility}
      >
        <Eye show={showOfferLink} />
      </button>
    </div>
    <button class="btn btn-sm btn-info mt-2" on:click={copyOfferLink}
      >Copy Link</button
    >
    <div class="label">
      <span class="label-text">Answer SDP:</span>
    </div>
    <div class="relative">
      <input
        type="password"
        class="input input-bordered w-full"
        bind:value={answerSDP}
      />
    </div>
    <button class="btn btn-sm btn-info mt-2" on:click={acceptAnswer}
      >Accept Answer</button
    >
  </div>
{/if}
<div
  class="p-4 space-y-4 bg-white border-2 border-dashed border-gray-200 rounded-xl"
  hidden={!isConnecting}
>
  <DragAndDrop {handleFilesPick} />
  {#if Object.keys(sendingFiles).length > 0}
    <div class="mt-4 space-y-2">
      {#each Object.entries(sendingFiles) as [key, sendingFile], index (key)}
        <div class="flex items-center justify-between">
          <p>{sendingFile.metaData.name}</p>
          <progress value={sendingFile.progress} max="100" class="w-1/2 mr-2" />
          <button
            on:click={() => removeSelectedFile(key)}
            class="btn btn-error"
          >
            Remove
          </button>
        </div>
      {/each}
    </div>
    <button class="btn btn-sm btn-info mt-2" on:click={sendAllFiles}
      >Send all files</button
    >
  {:else}
    <p class="mt-4">No files selected</p>
  {/if}
</div>
