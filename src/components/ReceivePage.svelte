<script lang="ts">
  import {
    CHUNK_SIZE_OPTIONS,
    DEFAULT_SEND_OPTIONS,
    GITHUB_LINK,
    STUN_SERVERS,
    WAIT_ICE_CANDIDATES_TIMEOUT
  } from '../configs';
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
  import QrModal from '../components/qr/QrModal.svelte';
  import Toast from './Toast.svelte';

  // get url parameters
  const urlSearchParams = new URLSearchParams(window.location.search);
  const params = Object.fromEntries(urlSearchParams.entries());

  const sdpEncoded = params['s'];
  if (sdpEncoded === null || !sdpEncoded) {
    window.location.assign(window.location.origin);
    throw new Error('no sdp found');
  }

  const pubKeyParam = params['p'];

  // options
  let isEncrypt: boolean = $state(pubKeyParam ? true : DEFAULT_SEND_OPTIONS.isEncrypt);
  // validate `c` (user-controllable via the shared link): NaN, 0, negative or
  // non-allowed values all fall back to the default chunk size
  const parsedChunkSize = params['c'] ? parseInt(params['c'], 10) : NaN;
  const chunkSize = CHUNK_SIZE_OPTIONS.includes(parsedChunkSize)
    ? parsedChunkSize
    : DEFAULT_SEND_OPTIONS.chunkSize;
  let rsa: CryptoKeyPair | undefined = $state(undefined); // private key
  let rsaPub: CryptoKey | undefined = $state(undefined); // public key from other peer
  // validate `p` (user-controllable via the shared link): the presence of a
  // non-empty `p` param is not enough to trust the key — a malformed base64
  // string or damaged SPKI DER makes the import throw/reject. On failure
  // downgrade to plaintext instead of silently sending with an undefined
  // public key (which would advertise encryption while sending nothing
  // usable), and surface the error to the user. The promise resolves to
  // `undefined` on failure so `generateAnswerSDP` can await the outcome
  // before deciding what to advertise to the peer.
  const rsaPubPromise: Promise<CryptoKey | undefined> = isEncrypt
    ? importRsaPublicKeyFromBase64(pubKeyParam).catch(() => {
        isEncrypt = false;
        addToastMessage('Invalid encryption key in link, falling back to plaintext', 'error');
        return undefined;
      })
    : Promise.resolve(undefined);

  // webRTC
  // validate `i` (user-controllable via the shared link): only accept a server
  // from the known STUN allowlist — anything else falls back to the default so
  // the peer's WebRTC stack is never pointed at an attacker-controlled
  // endpoint.
  const iceParam = params['i'];
  const iceServer =
    iceParam && STUN_SERVERS.includes(iceParam) ? iceParam : DEFAULT_SEND_OPTIONS.iceServer;
  let answerSDP = $state('');
  // set when the remote offer could not be applied (invalid `s` param or a
  // rejected setRemoteDescription): the answer can never be generated, so the
  // "Generating Answer" spinner must be replaced with an error state instead
  // of spinning forever
  let offerFailed = $state(false);
  let showAnswerCode = $state(false);
  let isConnecting = $state(false);
  let dataChannel: RTCDataChannel | undefined = $state(undefined);

  // components
  let receiver: Receiver | undefined = $state(undefined);
  let sender: Sender | undefined = $state(undefined);
  let sendMode = $state(false);
  let showNewFile = $state(false);
  let qrModal: QrModal | undefined = $state(undefined);

  const connection = new RTCPeerConnection({
    iceServers: [{ urls: iceServer }]
  });

  connection.ondatachannel = (event) => {
    dataChannel = event.channel;

    dataChannel.onopen = () => {
      addToastMessage('Connected', 'success');
      isConnecting = true;
      qrModal?.close();
    };
    dataChannel.onmessage = (event) => {
      // data-channel bytes are peer-controlled: a malformed/truncated protobuf
      // frame makes Message.decode throw synchronously, which would otherwise
      // escape as an uncaught error and stall the transfer with no feedback
      let message;
      try {
        message = Message.decode(new Uint8Array(event.data));
      } catch {
        addToastMessage('Invalid message from peer', 'error');
        return;
      }

      if (message.metaData !== undefined) {
        receiver?.onMetaData(message.id, message.metaData);
        showNewFile = true;
      } else if (message.chunk !== undefined) {
        receiver?.onChunkData(message.id, message.chunk as Uint8Array<ArrayBuffer>);
      } else if (message.receiveEvent !== undefined) {
        sender?.onReceiveEvent(message.id, message.receiveEvent);
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
    // validate `s` (user-controllable via the shared link): `sdpDecode` throws
    // synchronously on empty, invalid-base64, or non-SDP input, which would
    // otherwise crash the whole page during load instead of surfacing an error
    try {
      const sdpDecoded = sdpDecode(sdpEncoded, true);
      const sessionDesc: RTCSessionDescriptionInit = {
        type: 'offer',
        sdp: sdpDecoded
      };

      await connection.setRemoteDescription(sessionDesc);
    } catch {
      addToastMessage('Invalid SDP in link', 'error');
      offerFailed = true;
    }
  }
  // keep the promise: `generateAnswerSDP` awaits it before calling
  // `createAnswer`, so the answer is never queued against a connection whose
  // offer has not been applied. WebRTC serializes queued operations — a
  // `createAnswer` that runs after a rejected `setRemoteDescription` rejects
  // with InvalidStateError as an unhandled rejection and leaves the
  // "Generating Answer" spinner stuck forever.
  const setOfferPromise: Promise<void> = setOfferSDP(sdpEncoded);

  async function copyAnswerCode() {
    await navigator.clipboard.writeText(answerSDP);
    addToastMessage('Copied to clipboard', 'info');
  }

  async function generateAnswerSDP() {
    // await the offer-settling before creating the answer: if the remote
    // offer was invalid or rejected, `connection.signalingState` is still
    // `stable` and `createAnswer()` would reject with InvalidStateError as an
    // unhandled rejection, leaving the "Generating Answer" spinner stuck
    // forever. `offerFailed` is set by `setOfferSDP` on that same failure.
    await setOfferPromise;
    if (offerFailed || connection.signalingState !== 'have-remote-offer') {
      addToastMessage('Could not connect: offer from the sender is invalid', 'error');
      return;
    }

    let publicKeyBase64 = '';
    // await the `p` param key import first: if the param was malformed the
    // import was downgraded to plaintext above — generating the answer now
    // would otherwise advertise encryption to the peer (which would import an
    // empty key and fail the same way)
    rsaPub = await rsaPubPromise;
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
    }, WAIT_ICE_CANDIDATES_TIMEOUT);
  }
  // fire-and-forget, but never unhandled: if anything still rejects (e.g.
  // `createAnswer`/`setLocalDescription`), surface it instead of leaving the
  // spinner running with zero feedback
  generateAnswerSDP().catch(() => {
    offerFailed = true;
    addToastMessage('Could not connect: offer from the sender is invalid', 'error');
  });
</script>

<Collapse title="1. Answer" isOpen={!isConnecting}>
  {#if answerSDP}
    <p>
      Copy and send the answer code to the Offer or scan QR code to connect between peer. See
      <a
        class="link"
        href={GITHUB_LINK + '#how-does-it-work'}
        target="_blank"
        rel="noopener noreferrer">How does it work?</a
      >
    </p>
    <div class="relative mt-4">
      <input
        type={showAnswerCode ? 'text' : 'password'}
        class="input w-full pr-10"
        value={answerSDP}
        readonly
      />
      <div class="absolute top-0 right-0">
        <Eye
          onChange={(show) => {
            showAnswerCode = show;
          }}
        />
      </div>
    </div>
    <div class="mt-4 flex gap-2">
      <button class="btn btn-primary gap-2" onclick={copyAnswerCode}> Copy Answer </button>
      <QrModal bind:this={qrModal} qrData={answerSDP} title="Answer QR Code" />
    </div>
  {:else if offerFailed}
    <div class="flex flex-col items-center justify-center gap-2 text-error">
      <div>Could not connect: the offer in the link is invalid.</div>
      <div>Ask the sender to generate a new offer link.</div>
    </div>
  {:else}
    <div class="flex flex-col items-center justify-center gap-2">
      <span class="loading loading-spinner loading-lg"></span>
      <div>Generating Answer</div>
    </div>
  {/if}
</Collapse>

<Collapse title="2. Transfer Files" isOpen={isConnecting}>
  {#if dataChannel}
    <div class="flex w-full mb-4 mt-2">
      <button
        class="btn {sendMode ? 'btn-primary' : 'btn-ghost'} flex-grow border-black border-dotted"
        onclick={() => {
          sendMode = true;
        }}
      >
        Send
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
          Receive
        </button>
      </div>
    </div>
    <div hidden={!sendMode}>
      <Sender bind:this={sender} {dataChannel} {rsaPub} {isEncrypt} {chunkSize} />
    </div>
    <div hidden={sendMode}>
      <Receiver bind:this={receiver} {dataChannel} {isEncrypt} {rsa} />
    </div>
  {/if}
</Collapse>

<Toast />
