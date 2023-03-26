<script lang="ts">
  import { pathJoin } from "../utils/path";
  import { addToastMessage } from "../stores/toastStore";
  import { chunkSize, rtcConfig } from "../configs";
  import Eye from "../components/Eye.svelte";
  import { validateFileMetadata } from "../utils/validator";
  import { Message, MetaData } from "../proto/message";
  import DragAndDrop from "../components/DragAndDrop.svelte";

  // web rtc
  let isConnecting: boolean = false;

  const connection = new RTCPeerConnection(rtcConfig);

  let dataChannel = connection.createDataChannel("data");
  dataChannel.onopen = (event) => {
    addToastMessage(`Connected`);
    isConnecting = true;
  };
  dataChannel.onmessage = (event) => {};
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
    const fileReader = new FileReader();
    let offset = 0;

    fileReader.onload = (event: ProgressEvent<FileReader>) => {
      const result = event.target?.result;
      if (result && typeof result !== "string") {
        dataChannel.send(
          Message.encode({
            id: sendingFile.metaData.name,
            fileChunk: new Uint8Array(result),
          }).finish()
        );
        offset += result.byteLength;

        sendingFiles[key].progress = Math.round(
          (offset / sendingFile.metaData.size) * 100
        );

        if (offset < sendingFile.metaData.size) {
          readNextChunk();
          return;
        }

        sendingFiles[key].success = true;
        addToastMessage(`File ${sendingFile.metaData.name} sent successfully`);
      }
    };

    fileReader.onerror = (error: ProgressEvent<FileReader>) => {
      console.error(error);
      addToastMessage(`Error reading file ${sendingFile.metaData.name}`);
    };

    function readNextChunk() {
      const slice = sendingFile.file.slice(offset, offset + chunkSize);
      fileReader.readAsArrayBuffer(slice);
    }

    dataChannel.send(
      Message.encode({
        id: sendingFile.metaData.name,
        metaData: sendingFile.metaData,
      }).finish()
    );

    readNextChunk();
  }

  let sendingFiles: { [key: string]: SendingFile } = {};

  function removeSelectedFile(key: string) {
    delete sendingFiles[key];
    // call this to trigger update the map
    sendingFiles = sendingFiles;
  }

  function sendSelectedFiles() {}

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
  <title>Home</title>
  <meta name="description" content="Svelte demo app" />
</svelte:head>

<div class="flex justify-center">
  <div class="artboard artboard-horizontal phone-5">
    <button class="btn btn-primary" on:click={generateOfferLink}>
      Generate Offer Link
    </button>
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
      {#if sendingFiles}
        <div class="mt-4 space-y-2">
          {#each Object.entries(sendingFiles) as [key, sendingFile], index (key)}
            <div class="flex items-center justify-between">
              <p>{sendingFile.metaData.name}</p>
              <progress
                value={sendingFile.progress}
                max="100"
                class="w-1/2 mr-2"
              />
              <button
                on:click={() => removeSelectedFile(key)}
                class="btn btn-error"
              >
                Remove
              </button>
            </div>
          {/each}
        </div>
      {:else}
        <p class="mt-4">No files selected</p>
      {/if}
    </div>
  </div>
</div>
