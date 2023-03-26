<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { rtcConfig } from "../../configs";
  import { addToastMessage } from "../../stores/toastStore";
  import Eye from "../../components/Eye.svelte";
  import { validateFileMetadata } from "../../utils/validator";
  import { Message } from "../../proto/message";

  // web rtc
  let isConnecting: boolean = false;

  const connection = new RTCPeerConnection(rtcConfig);

  let dataChannel: RTCDataChannel;

  connection.ondatachannel = (event) => {
    dataChannel = event.channel;

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
  };

  let answerSDP: string = "";
  let showAnswerCode: boolean = false;

  const sdpEncoded = $page.url.searchParams.get("sdp");
  if (sdpEncoded === null || !sdpEncoded) {
    goto("/");
    throw new Error("no sdp found");
  }

  async function setOfferSDP(sdpEncoded: string) {
    const sdpDecoded = decodeURIComponent(sdpEncoded);
    const sessionDesc: RTCSessionDescriptionInit = {
      type: "offer",
      sdp: sdpDecoded,
    };

    await connection.setRemoteDescription(sessionDesc);
  }
  setOfferSDP(sdpEncoded);

  function toggleAnswerCodeVisibility() {
    showAnswerCode = !showAnswerCode;
  }

  async function copyAnswerCode() {
    await navigator.clipboard.writeText(answerSDP);
    addToastMessage("Copied to clipboard");
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
        return;
      }

      receivingFiles[message.id] = {
        metaData: message.metaData,
        progress: 0,
        receivedSize: 0,
        receivedChunks: [],
        success: false,
      };

      return;
    }

    if (message.fileChunk) {
      const arrayBuffer = message.fileChunk;
      const receivingFile = receivingFiles[message.id];
      receivingFiles[message.id].receivedChunks.push(arrayBuffer);
      receivingFiles[message.id].receivedSize += arrayBuffer.byteLength;

      receivingFiles[message.id].progress = Math.round(
        (receivingFiles[message.id].receivedSize /
          receivingFile.metaData.size) *
          100
      );

      if (receivingFile.receivedSize >= receivingFile.metaData.size) {
        receivingFiles[message.id].success = true;
      }
    }
  }

  function downloadFile(index: number) {
    const receivedFile = receivingFiles[index];
    const blobFile = new Blob(receivedFile.receivedChunks, {
      type: receivedFile.metaData.type,
    });
    const url = URL.createObjectURL(blobFile);
    const link = document.createElement("a");
    link.href = url;
    link.download = receivedFile.metaData.name;
    link.click();
    URL.revokeObjectURL(url);
  }
</script>

<svelte:head>
  <title>Home</title>
  <meta name="description" content="Svelte demo app" />
</svelte:head>

<div class="flex justify-center">
  <div class="artboard artboard-horizontal phone-5">
    {#if answerSDP}
      <div class="mt-4">
        <div class="label">
          <span class="label-text">Answer SDP:</span>
        </div>
        <div class="relative">
          <input
            type={showAnswerCode ? "text" : "password"}
            class="input input-bordered w-full"
            value={answerSDP}
            readonly
          />
          <button
            class="absolute top-2 right-2 p-2"
            on:click={toggleAnswerCodeVisibility}
          >
            <Eye show={showAnswerCode} />
          </button>
        </div>
        <button class="btn btn-sm btn-info mt-2" on:click={copyAnswerCode}
          >Copy Answer SDP</button
        >
      </div>
    {/if}
    {#if isConnecting}
      <div class="p-4 space-y-4 bg-white rounded-xl">
        {#if receivingFiles}
          <div class="space-y-2">
            {#each Object.entries(receivingFiles) as [key, receivedFile], index (key)}
              <div class="flex items-center justify-between">
                <p><strong>Name:</strong> {receivedFile.metaData.name}</p>
                <p><strong>Size:</strong> {receivedFile.metaData.size} bytes</p>
                <p><strong>Type:</strong> {receivedFile.metaData.type}</p>
                <progress
                  value={receivedFile.progress}
                  max="100"
                  class="w-1/2 mr-2"
                />
                {#if receivedFile.success}
                  <button
                    on:click={() => downloadFile(index)}
                    class="btn btn-primary"
                  >
                    Download
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <p>Connecting, waiting for files...</p>
        {/if}
      </div>
    {/if}
  </div>
</div>
