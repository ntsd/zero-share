<script lang="ts">
  import { buildURL } from '../utils/path';
  import { addToastMessage } from '../stores/toastStore';
  import { defaultSendOptions, githubLink, waitIceCandidatesTimeout } from '../configs';
  import Eye from './icons/Eye.svelte';
  import { Message } from '../proto/message';
  import Collapse from './layout/Collapse.svelte';
  import OfferOptions from './OfferOptions.svelte';
  import {
    exportRsaPublicKeyToBase64,
    generateRsaKeyPair,
    importRsaPublicKeyFromBase64
  } from '../utils/crypto';
  import { sdpDecode, sdpEncode } from '../utils/sdpEncode';
  import type { SendOptions } from '../type';
  import Sender from './sender/Sender.svelte';
  import Receiver from './receiver/Receiver.svelte';
  import QrModal from './qr/QrModal.svelte';
  import ScanQrModal from './qr/ScanQrModal.svelte';
  import Toast from './Toast.svelte';

  // options
  let sendOptions = $state(defaultSendOptions);
  let rsa: CryptoKeyPair | undefined = $state(undefined); // private key
  let rsaPub: CryptoKey | undefined = $state(undefined); // public key from other peer

  // webRTC
  let connection: RTCPeerConnection;
  let dataChannel: RTCDataChannel | undefined = $state(undefined);
  let isConnecting = $state(false);
  let generating = $state(false);
  let offerLink = $state('');
  let showOfferLink = $state(false);
  let answerSDP = $state('');

  // components
  let receiver: Receiver | undefined = $state(undefined);
  let sender: Sender | undefined = $state(undefined);
  let sendMode = $state(true);
  let showNewFile = $state(false);
  let showOfferOptions = $state(false);

  async function createSDPLink(offer: RTCSessionDescription) {
    let publicKeyBase64 = '';
    if (sendOptions.isEncrypt) {
      rsa = await generateRsaKeyPair();
      publicKeyBase64 = await exportRsaPublicKeyToBase64(rsa.publicKey);
    }

    const sdp = sdpEncode(offer.sdp);
    offerLink = buildURL(location.href.split('?')[0], 'receive', {
      s: sdp,
      i: defaultSendOptions.iceServer === sendOptions.iceServer ? '' : sendOptions.iceServer,
      c:
        defaultSendOptions.chunkSize === sendOptions.chunkSize
          ? ''
          : sendOptions.chunkSize.toString(),
      p: publicKeyBase64
    });
  }

  async function createPeerAndDataCannel() {
    connection = new RTCPeerConnection({
      iceServers: [{ urls: sendOptions.iceServer }],
      // "balanced": The ICE agent will bundle media streams
      // if it determines  that it is more efficient to do so. This is the default value.
      // "max-compat": The ICE agent will bundle media streams only
      // if it is required for compatibility with legacy endpoints.
      // "max-bundle": The ICE agent will always bundle media streams over a single ICE transport,
      // regardless of compatibility or efficiency.
      bundlePolicy: 'balanced',
      iceCandidatePoolSize: 4 // somehow this doesn't work
    });

    connection.onicecandidateerror = () => {
      addToastMessage('ICE Candidate error', 'error');
    };

    dataChannel = connection.createDataChannel('data', {
      ordered: false // we handle the order by response status
    });
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
      offerLink = '';
    };
    dataChannel.onclose = () => {
      addToastMessage('Disconnected', 'error');
      isConnecting = false;
      offerLink = '';
    };
  }

  async function generateOfferLink() {
    generating = true;
    await createPeerAndDataCannel();

    connection.onicecandidate = async (event) => {
      if (!event.candidate && connection.localDescription) {
        await createSDPLink(connection.localDescription);
        generating = false;
      }
    };

    const offer = await connection.createOffer({
      offerToReceiveVideo: false,
      offerToReceiveAudio: false
    });
    await connection.setLocalDescription(offer);

    // stop waiting for ice candidates if longer than timeout
    setTimeout(async () => {
      if (!connection.localDescription || !generating) return;
      addToastMessage('timeout waiting ICE candidates');
      await createSDPLink(connection.localDescription);
      generating = false;
    }, waitIceCandidatesTimeout);
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
      <span class="loading loading-spinner loading-lg"></span>
      <div>Generating Offer</div>
    </div>
  {:else}
    <p>
      Generate the SDP offer and build the offer link following the options. See
      <a
        class="link"
        href={githubLink + '#how-does-it-work'}
        target="_blank"
        rel="noopener noreferrer">How does it work?</a
      >
    </p>
    <div class="mt-4">
      {#if showOfferOptions}
        <OfferOptions onUpdate={onOptionsUpdate} />
      {/if}
      <div class="mt-4 flex flex-row gap-2">
        <button class="btn btn-primary" onclick={generateOfferLink}>Generate Offer</button>
        {#if !showOfferOptions}
          <button
            class="btn btn-secondary gap-2"
            onclick={() => {
              showOfferOptions = true;
            }}
          >
            Settings
          </button>
        {/if}
      </div>
    </div>
  {/if}
</Collapse>

<Collapse title="2. Accept Answer" isOpen={offerLink !== '' && !isConnecting}>
  {#if offerLink}
    <p class="">Copy and send the offer link or scan QR Code to connect between peers.</p>
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
      <button class="btn btn-primary gap-2" onclick={copyOfferLink}> Copy Link </button>
      <QrModal qrData={offerLink} title="Offer QR Code" />
    </div>
    <p class="mt-4">Enter the Answer Code to accept the Answer or scan the QR Code.</p>
    <div class="relative mt-4">
      <input type="password" class="input input-bordered w-full" bind:value={answerSDP} />
    </div>
    <div class="mt-4 flex gap-2">
      <button class="btn btn-primary" onclick={acceptAnswer}>Accept Answer</button>
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
  {#if dataChannel}
    <div class="flex w-full mb-4 mt-2">
      <button
        class="btn {sendMode ? 'btn-primary' : 'btn-ghost'} flex-grow border-black border-dotted"
        onclick={() => {
          sendMode = true;
        }}
      >
        <span class="btm-nav-label">Send</span>
      </button>
      <div class="indicator flex-grow">
        <span
          class="indicator-item badge badge-accent animate-bounce {showNewFile
            ? 'block'
            : 'hidden'}">New files</span
        >
        <button
          class="btn {sendMode ? 'btn-ghost' : 'btn-primary'} w-full border-black border-dotted"
          onclick={() => {
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
  {/if}
</Collapse>

<Toast />
