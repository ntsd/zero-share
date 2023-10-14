<script lang="ts">
  import { defaultSendOptions, githubLink, waitIceCandidatesTimeout } from '../configs';
  import { addToastMessage } from '../stores/toastStore';
  import Eye from '../components/icons/Eye.svelte';
  import { Message } from '../proto/message';
  import Collapse from '../components/layout/Collapse.svelte';
  import {
    exportRsaPublicKeyToBase64,
    generateRsaKeyPair,
    importRsaPublicKeyFromBase64
  } from '../utils/crypto';
  import { sdpDecode, sdpEncode } from '../utils/sdpEncode';
  import Receiver from '../components/receiver/Receiver.svelte';
  import Sender from '../components/sender/Sender.svelte';
  import ClipboardIcon from '../components/icons/ClipboardIcon.svelte';
  import QrModal from '../components/qr/QrModal.svelte';

  // options
  let isEncrypt = defaultSendOptions.isEncrypt;
  let chunkSize = defaultSendOptions.chunkSize;
  let rsa: CryptoKeyPair; // private key
  let rsaPub: CryptoKey; // public key from other peer

  // webRTC
  let iceServer = defaultSendOptions.iceServer;
  let answerSDP = '';
  let showAnswerCode = false;

  // components
  let receiver: Receiver;
  let sender: Sender;
  let sendMode = false;
  let showNewFile = false;
  let qrModal: QrModal;

  // get url parameters
  const urlSearchParams = new URLSearchParams(window.location.search);
  const params = Object.fromEntries(urlSearchParams.entries());

  const sdpEncoded = params['s'];
  if (sdpEncoded === null || !sdpEncoded) {
    window.location.assign(window.location.origin);
    throw new Error('no sdp found');
  }
  const iceServerParam = params['i'];
  if (iceServerParam) {
    iceServer = iceServerParam;
  }
  const chunkSizeParam = params['c'];
  if (chunkSizeParam) {
    chunkSize = parseInt(chunkSizeParam);
  }
  const pubKeyParam = params['p'];
  if (pubKeyParam) {
    isEncrypt = true;
    importRsaPublicKeyFromBase64(pubKeyParam).then((pub) => {
      rsaPub = pub;
    });
  } else {
    isEncrypt = false;
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
      qrModal.close();
    };
    dataChannel.onmessage = (event) => {
      const message = Message.decode(new Uint8Array(event.data));

      if (message.metaData !== undefined) {
        receiver.onMetaData(message.id, message.metaData);
        showNewFile = true;
      } else if (message.chunk !== undefined) {
        receiver.onChunkData(message.id, message.chunk);
      } else if (message.receiveEvent !== undefined) {
        sender.onReceiveEvent(message.id, message.receiveEvent);
      }
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

    // stop waiting for ice candidates if longer than timeout
    setTimeout(async () => {
      if (!connection.localDescription || answerSDP) return;
      addToastMessage('Timeout waiting ICE candidates');
      answerSDP = sdpEncode(connection.localDescription.sdp) + '|' + publicKeyBase64;
    }, waitIceCandidatesTimeout);
  }
  generateAnswerSDP();
</script>

<Collapse title="1. Answer" isOpen={!isConnecting}>
  {#if answerSDP}
    <p>
      Copy and send the answer code to the Offer or scan QR code to connect between peer. See
      <a
        class="link"
        href={githubLink + '#how-does-it-work'}
        target="_blank"
        rel="noopener noreferrer">How does it work?</a
      >
    </p>
    <div class="relative mt-4">
      <input
        type={showAnswerCode ? 'text' : 'password'}
        class="input input-bordered w-full"
        value={answerSDP}
        readonly
      />
      <div class="absolute top-0 right-0 p-1">
        <Eye
          onChange={(show) => {
            showAnswerCode = show;
          }}
        />
      </div>
    </div>
    <div class="mt-4 flex gap-2">
      <button class="btn btn-primary gap-2" on:click={copyAnswerCode}>
        <ClipboardIcon />Copy Answer
      </button>
      <QrModal bind:this={qrModal} qrData={answerSDP} title="Answer QR Code" />
    </div>
  {:else}
    <div class="flex flex-col items-center justify-center gap-2">
      <span class="loading loading-spinner loading-lg" />
      <div>Generating Answer</div>
    </div>
  {/if}
</Collapse>
<Collapse title="2. Transfer Files" isOpen={isConnecting}>
  <div class="flex w-full mb-4 mt-2">
    <button
      class="btn {sendMode ? 'btn-primary' : 'btn-ghost'} flex-grow border-black border-dotted"
      on:click={() => {
        sendMode = true;
      }}
    >
      <span class="btm-nav-label">Send</span>
    </button>
    <div class="indicator flex-grow">
      <span
        class="indicator-item badge badge-accent animate-bounce {showNewFile ? 'block' : 'hidden'}"
        >New files</span
      >
      <button
        class="btn {sendMode ? 'btn-ghost' : 'btn-primary'} w-full border-black border-dotted"
        on:click={() => {
          showNewFile = false;
          sendMode = false;
        }}
      >
        <span class="btm-nav-label">Receive</span>
      </button>
    </div>
  </div>
  <div hidden={!sendMode}>
    <Sender bind:this={sender} {dataChannel} {rsaPub} {isEncrypt} {chunkSize} />
  </div>
  <div hidden={sendMode}>
    <Receiver bind:this={receiver} {dataChannel} {isEncrypt} {rsa} />
  </div>
</Collapse>
