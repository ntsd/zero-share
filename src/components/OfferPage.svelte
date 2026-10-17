<script lang="ts">
  import { buildURL } from '../utils/path';
  import { addToastMessage } from '../stores/toastStore';
  import {
    DEFAULT_SEND_OPTIONS,
    GITHUB_LINK,
    WAIT_ICE_CANDIDATES_TIMEOUT,
    resolveIceServer
  } from '../configs';
  import Eye from './icons/Eye.svelte';
  import Collapse from './layout/Collapse.svelte';
  import { handlePeerMessage } from '../utils/peerMessage';
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
  // Effective encryption mode for this session. It starts from the user's
  // setting and is then settled by the handshake itself: acceptAnswer pins
  // it from the answer's key portion (present = encrypted, empty =
  // plaintext), and onOptionsUpdate only re-syncs it from the setting while
  // no offer link exists — once the link's `p` key has pinned the session,
  // a live settings toggle must not desync Sender/Receiver from the peer's
  // settled mode.
  let effectiveEncrypt = $state(sendOptions.isEncrypt);

  // webRTC
  let connection: RTCPeerConnection;
  let dataChannel: RTCDataChannel | undefined = $state(undefined);
  // Monotonically increasing generation counter: every offer link carries the
  // generation that minted its RSA keypair and created its peer. The ICE-
  // candidate fallback timer checks this token at fire time, so a timer left
  // over from a previous generateOfferLink() generation — whose closure holds
  // that generation's publicKeyBase64 — can never build a link after the user
  // regenerates: the peer's `connection.localDescription` would now belong to
  // the NEW generation while the timer's captured key belongs to the OLD one
  // (a link whose `p` key no longer matches the re-minted rsa private key).
  let offerGeneration = 0;
  // Pending ICE-candidate fallback timer id of the latest generation. Cleared
  // up front on every regeneration so a stale timer cannot fire at all.
  let iceCandidateTimer: ReturnType<typeof setTimeout> | undefined = undefined;
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

  // pure URL assembly — NO crypto here: the RSA keypair is minted exactly
  // once at the top of generateOfferLink() (before the peer is created), so
  // whichever path wins the ICE-candidate race builds a link whose `p` param
  // always matches the `rsa` private key used to encrypt outgoing files.
  // Minting a fresh pair per call rotated the key under the link and broke
  // every encrypted transfer whenever the onicecandidate and setTimeout
  // fallback paths both ran.
  function createSDPLink(offer: RTCSessionDescription, publicKeyBase64: string) {
    const sdp = sdpEncode(offer.sdp);
    // resolve the ICE server through the shared predicate so the link's `i`
    // param always matches what this peer's RTCPeerConnection actually uses —
    // the receiver honors exactly this value (same predicate in configs)
    const iceServer = resolveIceServer(sendOptions.iceServer);
    offerLink = buildURL(location.href.split('?')[0], 'receive', {
      s: sdp,
      i: DEFAULT_SEND_OPTIONS.iceServer === iceServer ? '' : iceServer,
      c:
        DEFAULT_SEND_OPTIONS.chunkSize === sendOptions.chunkSize
          ? ''
          : sendOptions.chunkSize.toString(),
      p: publicKeyBase64
    });
  }

  async function createPeerAndDataCannel() {
    // same shared resolver as the `i` link param in createSDPLink: this peer
    // must use the exact server the receiver will honor (see configs)
    const iceServer = resolveIceServer(sendOptions.iceServer);
    connection = new RTCPeerConnection({
      iceServers: [{ urls: iceServer }],
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
    // WebRTC's default binaryType is 'blob': every binary frame would arrive
    // as a Blob, and `new Uint8Array(blob)` in handlePeerMessage yields a
    // zero-length view, so Message.decode silently produced an empty message
    // and every frame was dropped. 'arraybuffer' delivers the real bytes.
    dataChannel.binaryType = 'arraybuffer';
    dataChannel.onopen = () => {
      addToastMessage('Connected', 'success');
      isConnecting = true;
    };
    dataChannel.onmessage = (event) => {
      handlePeerMessage(event, {
        onMetaData: (id, metaData) => {
          receiver?.onMetaData(id, metaData);
          showNewFile = true;
        },
        onChunkData: (id, chunk) => receiver?.onChunkData(id, chunk),
        onReceiveEvent: (id, receiveEvent) => sender?.onReceiveEvent(id, receiveEvent)
      });
    };
    dataChannel.onerror = () => {
      addToastMessage('WebRTC error', 'error');
      isConnecting = false;
      offerLink = '';
      // A failed channel never recovers: propagate "connection lost" into the
      // file pipelines so in-flight/queued work exits with an accurate error
      // instead of dead-ending or re-firing false per-chunk errors.
      sender?.onChannelClose();
      receiver?.onChannelClose();
    };
    dataChannel.onclose = () => {
      addToastMessage('Disconnected', 'error');
      isConnecting = false;
      offerLink = '';
      // The channel will never deliver again (peer closed the tab, dropped
      // the network, or a "Generate Offer" regeneration closed it): mark the
      // in-flight files on both sides "connection lost" and stop their
      // pipelines — the old handlers only reset link state, leaving files in
      // Processing forever and queued chunks re-firing corrupt-chunk toasts.
      sender?.onChannelClose();
      receiver?.onChannelClose();
    };
  }

  async function generateOfferLink() {
    // surface a visible warning when the user's custom ICE server value is
    // rejected by the shared predicate — the link and this peer both fall
    // back to the default, and staying silent would advertise a server that
    // is not actually used
    if (sendOptions.iceServer !== resolveIceServer(sendOptions.iceServer)) {
      addToastMessage(
        `Invalid ICE server, using default (${DEFAULT_SEND_OPTIONS.iceServer})`,
        'error'
      );
    }
    // Tear down any previous offer generation BEFORE minting the new keypair:
    // closing the old RTCPeerConnection and its data channel releases the
    // leaked ICE agent's UDP sockets/STUN traffic (every regeneration used to
    // leak one live peer) and stops its onopen/onerror/onclose handlers from
    // firing later and stomping this generation's isConnecting/offerLink.
    // Null the handlers first so nothing on the dead channel can run even in
    // the window between close() and the channel actually closing.
    if (iceCandidateTimer !== undefined) {
      clearTimeout(iceCandidateTimer);
      iceCandidateTimer = undefined;
    }
    offerGeneration++;
    const generation = offerGeneration;
    if (dataChannel) {
      dataChannel.onopen = null;
      dataChannel.onmessage = null;
      dataChannel.onerror = null;
      dataChannel.onclose = null;
      dataChannel.close();
      dataChannel = undefined;
    }
    // close() throws InvalidStateError on an already-closed peer (the
    // previous generation's peer settles to 'closed' asynchronously after
    // its own close, and a failed previous attempt still leaves `connection`
    // pointing at it) — so guard on connectionState
    if (connection && connection.connectionState !== 'closed') {
      connection.close();
    }
    // Reset the settled peer crypto so the NEW generation starts clean: the
    // previous peer's public key and settled mode must not leak into the new
    // link's handshake, or the new peer (whose keypair was re-minted in its
    // own generateAnswerSDP) cannot decrypt what this sender emits.
    // rsaPub = undefined makes Sender.onFilesPick's `if (!rsaPub)` guard
    // reject a pick made before the new answer is accepted, instead of
    // wrapping the AES key for the DEAD peer's public key. Picking again
    // after the new acceptAnswer() re-imports the new peer's key.
    rsaPub = undefined;
    // Pin the new session's mode to the current setting (a plain $state
    // initializer is not a live binding off sendOptions); the new link's `p`
    // param and the new acceptAnswer() then re-pin it exactly as in the
    // first-time flow. onOptionsUpdate's link-gated re-sync is skipped here
    // because the old offer link is still set until createSDPLink replaces
    // it — so without this reset the previous session's effectiveEncrypt
    // would survive a plaintext<->encrypted flip across regenerations.
    effectiveEncrypt = sendOptions.isEncrypt;
    // UI state belonging to the dead generation must not ride into the new
    // one: a leftover "New files" badge would keep bouncing on the Receive
    // tab of the fresh generation; a stale isConnecting (set by the old
    // channel's onopen, which was just detached so onclose can't clear it)
    // would keep "2. Accept Answer" collapsed and misreport the new channel
    // as connected; a lingering answer code would let a stale Accept click
    // run setRemoteDescription against the new peer ("Invalid answer code").
    showNewFile = false;
    isConnecting = false;
    answerSDP = '';
    // Clear the dead generation's offer link too. Its SDP belongs to the peer
    // just closed above (no data channel can ever open from it) and its `p`
    // key belongs to the rsa keypair about to be re-minted in the try block —
    // so it is dead in every sense: even a somehow-answered handshake would
    // break encrypted transfers, and acceptAnswer() would call
    // setRemoteDescription on the NEW peer (signalingState still `stable`) and
    // reject every answer from a peer who opened the stale link. Resetting it
    // HERE — in the teardown block, before the new generation's try/catch, not
    // only in the catch — guarantees the stale link is never presented during
    // the regeneration window, that a FAILED attempt returns to the clean
    // "generate" state with no dead link to copy/QR/accept, and that the
    // template's `offerLink !== ''` gate (encryptionLocked + the Accept Answer
    // section) re-locks/unlocks with the actual live link.
    offerLink = '';
    generating = true;
    // hoisted out of createSDPLink so the keypair is minted exactly ONCE per
    // offer — before the peer exists — and can never be rotated by the second
    // link-build path racing the ICE-candidate timeout. `offerBuilt` is a
    // per-invocation local claimed synchronously by whichever path (candidate
    // completion or timeout fallback) builds the link first, so the link —
    // and its `p` key — is built at most once per invocation; a fresh
    // generateOfferLink() call gets fresh locals, i.e. the reset for free
    let publicKeyBase64 = '';
    let offerBuilt = false;
    try {
      if (sendOptions.isEncrypt) {
        rsa = await generateRsaKeyPair();
        publicKeyBase64 = await exportRsaPublicKeyToBase64(rsa.publicKey);
      }
      // `new RTCPeerConnection` / `createDataChannel` can throw synchronously
      // (e.g. SecurityError for an invalid iceServers config,
      // NotFoundError) and `createOffer` / `setLocalDescription` can reject —
      // surface any of them instead of an unhandled rejection that leaves the
      // "Generating Offer" spinner stuck forever, and re-enable the button
      await createPeerAndDataCannel();

      connection.onicecandidate = (event) => {
        if (!event.candidate && connection.localDescription && !offerBuilt) {
          // claim BEFORE building: createSDPLink is pure URL assembly (no
          // awaits), so nothing can interleave between the claim and the build
          offerBuilt = true;
          createSDPLink(connection.localDescription, publicKeyBase64);
          generating = false;
        }
      };

      const offer = await connection.createOffer({
        offerToReceiveVideo: false,
        offerToReceiveAudio: false
      });
      await connection.setLocalDescription(offer);

      // stop waiting for ice candidates if longer than timeout. The id is
      // tracked at script scope so the next generation can clear it up front
      // (see the teardown at the top of this function): a stale timer's
      // closure holds the PREVIOUS generation's publicKeyBase64, and after a
      // regeneration its guard would read the NEW peer's localDescription and
      // pass — building a link whose `p` key no longer matches the re-minted
      // rsa private key and silently breaking every encrypted transfer.
      iceCandidateTimer = setTimeout(() => {
        iceCandidateTimer = undefined;
        // generation token first: the per-invocation offerBuilt local cannot
        // see across generations, but a stale timer would otherwise survive
        // regeneration because its guard reads the script-scope connection
        // (now the new peer) and generating (now true for the new offer)
        if (generation !== offerGeneration) return;
        // `generating`/`offerBuilt` are claimed by the onicecandidate path the
        // moment it builds: without these checks this fallback would overwrite
        // `offerLink` with a redundant second link
        if (!connection.localDescription || !generating || offerBuilt) return;
        offerBuilt = true;
        addToastMessage('timeout waiting ICE candidates');
        createSDPLink(connection.localDescription, publicKeyBase64);
        generating = false;
      }, WAIT_ICE_CANDIDATES_TIMEOUT);
    } catch {
      generating = false;
      addToastMessage('Could not generate the offer', 'error');
    }
  }

  async function copyOfferLink() {
    try {
      await navigator.clipboard.writeText(offerLink);
      addToastMessage('Copied to clipboard', 'info');
    } catch {
      // Rejection (non-secure context, denied permission, unavailable API)
      // must not escape as an unhandled rejection with zero feedback —
      // the user would believe the link was copied when it was not.
      addToastMessage('Copy failed — select the link text and copy it manually', 'error');
    }
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

    // The answer's key portion — not the live sendOptions.isEncrypt — is the
    // source of truth for this session's encryption: the receiver always
    // emits `sdp|<public key>`, empty when plaintext and a base64 SPKI key
    // when encrypted. Gating on the live setting desyncs the session when
    // the user flips the toggle after generating the offer link: with the
    // setting OFF the import is skipped (rsaPub stays undefined and the
    // Sender stops encrypting while the peer keeps sending encrypted), and
    // with it ON against a downgraded peer it would import an empty key and
    // dead-end the handshake.
    if (hasSeparator && key === '') {
      // plaintext answer: either the link was plaintext from the start, or
      // the receiver deliberately downgraded because the `p` key was
      // malformed. Either way we must follow into plaintext instead of
      // bailing, or the handshake would never complete. The info toast also
      // makes a post-link-generation settings toggle visible instead of
      // silently desyncing the session (the select is disabled once the
      // link is live, but a synthetic change can still fire).
      effectiveEncrypt = false;
      addToastMessage('Peer answered in plaintext — continuing without encryption', 'info');
    } else if (key !== '') {
      // a key is present: the peer is in encrypted mode. Validate it — a
      // malformed/truncated answer code would otherwise reject here,
      // skipping setRemoteDescription and leaving a half-configured
      // connection with no error shown
      try {
        rsaPub = await importRsaPublicKeyFromBase64(key);
      } catch {
        addToastMessage('Invalid encryption key in answer code', 'error');
        return;
      }
      // pin the session to the peer's settled mode even if the live setting
      // moved behind the link/answer
      effectiveEncrypt = true;
    } else {
      // no `|` at all: a genuinely malformed code, not the receiver's
      // deliberate plaintext-downgrade signal — surface a visible error
      // instead of dead-ending the handshake
      addToastMessage('Invalid encryption key in answer code', 'error');
      return;
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
    // Until the offer link exists the setting IS the session mode, so keep
    // effectiveEncrypt in sync (a plain $state initializer is not a live
    // binding off sendOptions). Once the link is live the session's
    // encryption is pinned by the link's `p` key — and later by the
    // accepted answer's key portion — so a post-generation isEncrypt toggle
    // must NOT move effectiveEncrypt: Sender/Receiver would otherwise
    // desync from the peer's settled mode and silently corrupt (or fail)
    // every chunk.
    if (!offerLink) {
      effectiveEncrypt = sendOptions.isEncrypt;
      // Clear any imported peer key so a re-enabled encryption session after
      // a downgrade starts from a clean state instead of carrying the
      // previous peer's public key. Link-gated for the same reason the
      // re-sync above is: while the link is live the session's peer is
      // settled and rsaPub — imported by acceptAnswer, its only import path
      // — must survive a chunk-size / ICE-server options change, or the next
      // file would be sent with an empty key the receiver cannot decrypt.
      rsaPub = undefined;
    }
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
        <OfferOptions onUpdate={onOptionsUpdate} encryptionLocked={offerLink !== ''} />
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
