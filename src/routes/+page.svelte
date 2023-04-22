<script lang="ts">
  import { buildURL } from '../utils/path';
  import { addToastMessage } from '../stores/toastStore';
  import { defaultSendOptions } from '../configs';
  import Eye from '../components/Eye.svelte';
  import { Message } from '../proto/message';
  import Collapse from '../components/Collapse.svelte';
  import SenderOptions from '../components/SenderOptions.svelte';
  import { importRsaPublicKeyFromBase64 } from '../utils/crypto';
  import { sdpDecode, sdpEncode } from '../utils/sdpEncode';
  import Spinner from '../components/Spinner.svelte';
  import type { SendOptions } from '../type';
  import Sender from '../components/Sender.svelte';

  let sendOptions = defaultSendOptions;
  let isConnecting = false;
  let rsaPub: CryptoKey;

  let connection: RTCPeerConnection;
  let dataChannel: RTCDataChannel;

  let generating = false;
  let offerLink = '';
  let showOfferLink = false;
  let answerSDP = '';

  let sender: Sender;

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
    dataChannel.onmessage = (ev) => {
      const message = Message.decode(new Uint8Array(ev.data));

      if (message.receiveEvent !== undefined) {
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

    connection.onicecandidate = (event) => {
      if (!event.candidate && connection.localDescription) {
        const sdp = sdpEncode(connection.localDescription.sdp);
        offerLink = buildURL(location.href.split('?')[0], 'receive', {
          sdp: sdp,
          e2e: sendOptions.isEncrypt ? '' : '0',
          ice: defaultSendOptions.iceServer === sendOptions.iceServer ? '' : sendOptions.iceServer
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
    <div class="mt-2">
      <SenderOptions onUpdate={onOptionsUpdate} />
      <button class="btn btn-primary mt-2" on:click={generateOfferLink}>Generate Offer</button>
    </div>
  {/if}
</Collapse>

<Collapse title="2. Accept Answer" isOpen={offerLink !== '' && !isConnecting}>
  {#if offerLink}
    <p class="mt-2">Copy the offer link and send to the receiver to connect between peer.</p>
    <div class="relative mt-2">
      <input
        type={showOfferLink ? 'text' : 'password'}
        class="input input-bordered w-full"
        value={offerLink}
        readonly
      />
      <button
        class="absolute top-2 right-2 p-2"
        on:click={() => {
          showOfferLink = !showOfferLink;
        }}
      >
        <Eye show={showOfferLink} />
      </button>
    </div>
    <button class="btn btn-primary mt-2" on:click={copyOfferLink}>Copy Link</button>
    <p>Enter the Session Description Protocol (SDP) from the receiver to accept the answer.</p>
    <div class="relative mt-2">
      <input type="password" class="input input-bordered w-full" bind:value={answerSDP} />
    </div>
    <button class="btn btn-primary mt-2" on:click={acceptAnswer}>Accept Answer</button>
  {/if}
</Collapse>

<Collapse title="3. Send Files" isOpen={isConnecting}>
  <Sender bind:this={sender} {dataChannel} {rsaPub} {sendOptions} />
</Collapse>
