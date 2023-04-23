<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { defaultSendOptions } from '../../configs';
  import { addToastMessage } from '../../stores/toastStore';
  import Eye from '../../components/Eye.svelte';
  import { Message } from '../../proto/message';
  import Collapse from '../../components/Collapse.svelte';
  import {
    exportRsaPublicKeyToBase64,
    generateRsaKeyPair
  } from '../../utils/crypto';
  import { sdpDecode, sdpEncode } from '../../utils/sdpEncode';
  import Spinner from '../../components/Spinner.svelte';
  import Receiver from '../../components/Receiver.svelte';

  let iceServer = defaultSendOptions.iceServer;
  let answerSDP = '';
  let showAnswerCode = false;
  let isEncrypt = defaultSendOptions.isEncrypt;
  let rsa: CryptoKeyPair;
  let receiver: Receiver;

  // get url parameters
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
      const message = Message.decode(new Uint8Array(event.data));

      if (message.metaData !== undefined) {
        receiver.onMetaData(message.id, message.metaData);
      } else if (message.chunk !== undefined) {
        receiver.onChunkData(message.id, message.chunk);
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
  }
  generateAnswerSDP();
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
      <button
        class="absolute top-2 right-2 p-2"
        on:click={() => {
          showAnswerCode = !showAnswerCode;
        }}
      >
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
  <Receiver bind:this={receiver} {dataChannel} {isEncrypt} {rsa} />
</Collapse>
