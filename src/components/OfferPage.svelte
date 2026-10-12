<script lang="ts">
  import { buildURL } from '../utils/path';
  import { addToastMessage } from '../stores/toastStore';
  import { DEFAULT_SEND_OPTIONS, GITHUB_LINK, WAIT_ICE_CANDIDATES_TIMEOUT } from '../configs';
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
  let sendOptions = $state(DEFAULT_SEND_OPTIONS);
  let rsa: CryptoKeyPair | undefined = $state(undefined); // private key
  let rsaPub: CryptoKey | undefined = $state(undefined); // public key from other peer
  // Effective encryption mode for this session. Initialized from the user's
  // setting, but a plain $state initializer is NOT a live binding: the Settings
  // panel stays open and mutable while the offer is active, so the value would
  // go stale when the user toggles encryption after the downgrade branch (or
  // an encrypted accept) last wrote to it. onOptionsUpdate — the only place
  // sendOptions is mutated — re-syncs it on every change; the downgrade branch
  // may still override it to false for the current handshake.
  let effectiveEncrypt = $state(sendOptions.isEncrypt);

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
      i: DEFAULT_SEND_OPTIONS.iceServer === sendOptions.iceServer ? '' : sendOptions.iceServer,
      c:
        DEFAULT_SEND_OPTIONS.chunkSize === sendOptions.chunkSize
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
    try {
      // `new RTCPeerConnection` / `createDataChannel` can throw synchronously
      // (e.g. SecurityError for an invalid iceServers config,
      // NotFoundError) and `createOffer` / `setLocalDescription` can reject —
      // surface any of them instead of an unhandled rejection that leaves the
      // "Generating Offer" spinner stuck forever, and re-enable the button
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
      }, WAIT_ICE_CANDIDATES_TIMEOUT);
    } catch {
      generating = false;
      addToastMessage('Could not generate the offer', 'error');
    }
  }

  async function copyOfferLink() {
    await navigator.clipboard.writeText(offerLink);
    addToastMessage('Copied to clipboard', 'info');
  }

  // parse the answer code (`sdp|<public key base64>`): the encoded SDP part
  // is a URL-safe base64 alphabet (never contains `|`), so splitting on the
  // LAST `|` is safe even if the key portion ever contains one.
  // `hasSeparator` tells a truly malformed code (no `|` at all) apart from
  // the receiver's deliberate plaintext downgrade (well-formed code with an
  // empty key portion — it dropped encryption because the `p` key in its
  // link was malformed, so it answers with an empty key by design).
  function parseAnswerCode(answerCode: string) {
    const sep = answerCode.lastIndexOf('|');
    if (sep === -1) return { sdp: answerCode, key: '', hasSeparator: false };
    return { sdp: answerCode.slice(0, sep), key: answerCode.slice(sep + 1), hasSeparator: true };
  }

  async function acceptAnswer() {
    const { sdp, key, hasSeparator } = parseAnswerCode(answerSDP);

    if (sendOptions.isEncrypt) {
      if (hasSeparator && key === '') {
        // the receiver deliberately downgraded to plaintext: importing an
        // empty key would reject and the handshake would never complete, so
        // follow the receiver into plaintext instead of bailing
        effectiveEncrypt = false;
        addToastMessage(
          'Peer could not use the encryption key — continuing without encryption',
          'info'
        );
      } else {
        // validate the answer's public key: a malformed/truncated answer code
        // (e.g. missing the `|` separator or a damaged non-empty key) would
        // otherwise reject here, skipping setRemoteDescription and leaving a
        // half-configured connection with no error shown
        try {
          rsaPub = await importRsaPublicKeyFromBase64(key);
        } catch {
          addToastMessage('Invalid encryption key in answer code', 'error');
          return;
        }
      }
    }

    // validate the SDP in the answer code (user-pasted or QR-scanned):
    // `sdpDecode` throws synchronously on empty, invalid-base64, or non-SDP
    // input, which would otherwise escape as an unhandled rejection with no
    // error shown to the user
    try {
      const remoteDesc: RTCSessionDescriptionInit = {
        type: 'answer',
        sdp: sdpDecode(sdp, false)
      };
      await connection.setRemoteDescription(remoteDesc);
    } catch {
      addToastMessage('Invalid answer code', 'error');
    }
  }

  function onOptionsUpdate(options: SendOptions) {
    sendOptions = options;
    // effectiveEncrypt is a plain $state, not a live binding off sendOptions,
    // so the Settings panel (open and mutable while the offer is active) could
    // otherwise leave it stale after the downgrade branch or an encrypted
    // accept last wrote to it: re-enabling encryption post-downgrade would
    // keep Sender at isEncrypt=false with no AES key, and toggling off post-
    // encrypted-accept would leave rsaPub set while Sender no longer encrypts.
    // Re-sync here on every options change; the downgrade branch may still
    // override it to false for the current handshake.
    effectiveEncrypt = sendOptions.isEncrypt;
    // Clear any imported peer key so a re-enabled encryption session after a
    // downgrade starts from a clean state instead of carrying the previous
    // peer's public key.
    rsaPub = undefined;
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
        href={GITHUB_LINK + '#how-does-it-work'}
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
        class="input w-full pr-10"
        value={offerLink}
        readonly
      />
      <div class="absolute top-0 right-0">
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
      <input type="password" class="input w-full" bind:value={answerSDP} />
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
      <Sender
        bind:this={sender}
        {dataChannel}
        {rsaPub}
        isEncrypt={effectiveEncrypt}
        chunkSize={sendOptions.chunkSize}
      />
    </div>
    <div hidden={sendMode}>
      <Receiver bind:this={receiver} {dataChannel} isEncrypt={effectiveEncrypt} {rsa} />
    </div>
  {/if}
</Collapse>

<Toast />
