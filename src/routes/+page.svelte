<script lang="ts">
  import { buildURL } from '../utils/path';
  import { addToastMessage } from '../stores/toastStore';
  import { defaultSendOptions } from '../configs';
  import Eye from '../components/Eye.svelte';
  import { Message } from '../proto/message';
  import Collapse from '../components/Collapse.svelte';
  import SenderOptions from '../components/SenderOptions.svelte';
  import {
    exportRsaPublicKeyToBase64,
    generateRsaKeyPair,
    importRsaPublicKeyFromBase64
  } from '../utils/crypto';
  import { sdpDecode, sdpEncode } from '../utils/sdpEncode';
  import Spinner from '../components/Spinner.svelte';
  import type { SendOptions } from '../type';
  import Sender from '../components/Sender.svelte';
  import Receiver from '../components/Receiver.svelte';
  import ClipboardIcon from '../components/ClipboardIcon.svelte';
  import QrModal from '../components/QrModal.svelte';
  import ScanQrModal from '../components/ScanQrModal.svelte';

  // options
  let sendOptions = defaultSendOptions;
  let rsa: CryptoKeyPair; // private key
  let rsaPub: CryptoKey; // public key from other peer

  // webRTC
  let connection: RTCPeerConnection;
  let dataChannel: RTCDataChannel;
  let isConnecting = false;
  let generating = false;
  let offerLink = '';
  let showOfferLink = false;
  let answerSDP = '';

  // components
  let receiver: Receiver;
  let sender: Sender;
  let sendMode = true;
  let showNewFile = false;

  async function connectPeerAndCreateDataCannel() {
    connection = new RTCPeerConnection({
      iceServers: [{ urls: sendOptions.iceServer }]
    });

    connection.onicecandidateerror = () => {
      addToastMessage('Ice candidate error', 'error');
    };

    dataChannel = connection.createDataChannel('data');
    dataChannel.onopen = () => {
      addToastMessage('Connected', 'success');
      isConnecting = true;
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
  }

  async function generateOfferLink() {
    generating = true;
    await connectPeerAndCreateDataCannel();

    connection.onicecandidate = async (event) => {
      if (!event.candidate && connection.localDescription) {
        let publicKeyBase64 = '';
        if (sendOptions.isEncrypt) {
          rsa = await generateRsaKeyPair();
          publicKeyBase64 = await exportRsaPublicKeyToBase64(rsa.publicKey);
        }

        const sdp = sdpEncode(connection.localDescription.sdp);
        offerLink = buildURL(location.href.split('?')[0], 'receive', {
          sdp: sdp,
          ice: defaultSendOptions.iceServer === sendOptions.iceServer ? '' : sendOptions.iceServer,
          cs:
            defaultSendOptions.chunkSize === sendOptions.chunkSize
              ? ''
              : sendOptions.chunkSize.toString(),
          pub: publicKeyBase64
        });
        generating = false;
      }
    };

    const offer = await connection.createOffer({
      offerToReceiveVideo: false,
      offerToReceiveAudio: false
    });
    await connection.setLocalDescription(offer);
  }

  async function copyOfferLink() {
    await navigator.clipboard.writeText(offerLink);
    addToastMessage('Copied to clipboard', 'info');
  }

  async function acceptAnswer() {
    const [sdp, pubKeyB64] = answerSDP.split('|');

    if (sendOptions.isEncrypt) {
      rsaPub = await importRsaPublicKeyFromBase64(pubKeyB64);
    }

    const remoteDesc: RTCSessionDescriptionInit = {
      type: 'answer',
      sdp: sdpDecode(sdp, false)
    };
    await connection.setRemoteDescription(remoteDesc);
  }

  function onOptionsUpdate(options: SendOptions) {
    sendOptions = options;
  }
</script>

<Collapse title="1. Generate Offer" isOpen={!offerLink}>
  {#if generating}
    <div class="flex flex-col items-center justify-center gap-2">
      <Spinner />
      <div>Generating Offer</div>
    </div>
  {:else}
    <p>Generate local SDP and build the offer link to connect with the peer.</p>
    <div class="mt-4">
      <SenderOptions onUpdate={onOptionsUpdate} />
      <button class="btn btn-primary mt-4" on:click={generateOfferLink}>Generate Offer</button>
    </div>
  {/if}
</Collapse>

<Collapse title="2. Accept Answer" isOpen={offerLink !== '' && !isConnecting}>
  {#if offerLink}
    <p class="">Copy the offer link and send to the receiver to connect between peer.</p>
    <div class="mt-2 relative">
      <input
        type={showOfferLink ? 'text' : 'password'}
        class="input input-bordered w-full"
        value={offerLink}
        readonly
      />
      <div class="absolute top-0 right-0 p-1">
        <Eye
          onChange={(show) => {
            showOfferLink = show;
          }}
        />
      </div>
    </div>
    <div class="mt-4 flex gap-2">
      <button class="btn btn-primary gap-2" on:click={copyOfferLink}>
        <ClipboardIcon />Copy Link
      </button>
      <QrModal qrValue={offerLink} title="Offer QR Code" />
    </div>
    <p class="mt-4">
      Enter the Session Description Protocol (SDP) from the receiver to accept the answer.
    </p>
    <div class="relative mt-4">
      <input type="password" class="input input-bordered w-full" bind:value={answerSDP} />
    </div>
    <div class="mt-4 flex gap-2">
      <button class="btn btn-primary" on:click={acceptAnswer}>Accept Answer</button>
      <ScanQrModal
        onScanSuccess={(data) => {
          answerSDP = data;
          acceptAnswer();
        }}
      />
    </div>
  {/if}
</Collapse>

<Collapse title="3. Transfer Files" isOpen={isConnecting}>
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
    <Sender
      bind:this={sender}
      {dataChannel}
      {rsaPub}
      isEncrypt={sendOptions.isEncrypt}
      chunkSize={sendOptions.chunkSize}
    />
  </div>
  <div hidden={sendMode}>
    <Receiver bind:this={receiver} {dataChannel} isEncrypt={sendOptions.isEncrypt} {rsa} />
  </div>
</Collapse>
