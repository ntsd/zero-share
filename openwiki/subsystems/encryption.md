---
type: 'Reference'
title: 'Subsystem: Encryption (WebCrypto)'
openwiki_generated: true
sources:
  - id: openwiki-source-f582d8a11a0cfc8a438a5ae2
    resource: repo://src/components/OfferPage.svelte
  - id: openwiki-source-ea57456033ae6393e62158ed
    resource: repo://src/components/ReceivePage.svelte
  - id: openwiki-source-b44a738391e0dd972a16a1ef
    resource: repo://src/components/receiver/Receiver.svelte
  - id: openwiki-source-d6db73741d251c8c754ff256
    resource: repo://src/components/sender/Sender.svelte
  - id: openwiki-source-578f160ff71c06304de2a610
    resource: repo://src/configs.ts
  - id: openwiki-source-825971ed9c72d5969af1b150
    resource: repo://src/utils/crypto.ts
generated: { by: 'hermes', at: '2026-10-03T07:07:26.852Z' }
verified:
  - by: openwiki/0.6.0
    at: 2026-10-03T07:07:26.852Z
---

# Subsystem: Encryption (WebCrypto)

Zero Share layers **optional application-layer file encryption** on top of WebRTC's DTLS. The motivation (per the README): DTLS secures the channel, but the unauthenticated SDP offer/answer link exchange is exposed to man-in-the-middle attack, so file content gets a second, independent encryption layer. All crypto uses the browser-native WebCrypto API (`crypto.subtle`) — no crypto dependencies are installed. [`repo://README.md#L30-L36`], [`repo://src/utils/crypto.ts#L1-L23`]

> **Factual state at HEAD:** the configuration is **RSA-OAEP with `modulusLength: 1024`** and **AES-GCM with `length: 256`**. (The 2026-10 commit that bumped the symmetric key changed AES 128→256; the RSA modulus remains 1024.) The README's "PGP" label is informal — the implementation is pure WebCrypto RSA-OAEP + AES-GCM. [`repo://src/utils/crypto.ts#L1-L11`]

## Key management: one RSA pair per peer, one AES key per file

- Each peer generates **its own RSA-OAEP-1024 key pair** (`publicExponent 65537`, SHA-256 hash) when it creates its outgoing artifact — the offer peer inside `createSDPLink`, the answer peer inside `generateAnswerSDP`, which first awaits the validated import of the `p`-param key so a malformed key downgrades the session to plaintext before any answer is advertised. The key pair is held in page-level state (`rsa` private + `rsaPub` imported). [`repo://src/utils/crypto.ts#L1-L17`], [`repo://src/components/OfferPage.svelte#L43-L48`], [`repo://src/components/ReceivePage.svelte#L138-L142`]
- The peers exchange **public keys through the shared artifacts**: the offer peer's base64 public key is embedded in the offer link's `p` query param, and the answer peer's base64 public key is appended after `|` in the answer code. The answer page _derives_ `isEncrypt` from the presence of `p`, so encryption mode propagates from the offer side automatically. [`repo://src/components/OfferPage.svelte#L51-L59`], [`repo://src/components/ReceivePage.svelte#L33-L49`], [`repo://src/components/OfferPage.svelte#L141-L146`]
- When the sender picks files, **each file gets a fresh AES-256-GCM key**; that key is exported raw and wrapped (`encrypt`) with the receiver's RSA public key. The wrapped key bytes ride in the `MetaData.key` field of the first `metaData` message. The receiver unwraps it with its private key in `onMetaData` and keeps the resulting `CryptoKey` on the file detail. [`repo://src/components/sender/Sender.svelte#L182-L215`], [`repo://src/utils/crypto.ts#L44-L55`], [`repo://src/components/receiver/Receiver.svelte#L35-L42`]

## Payload encryption: AES-256-GCM with prepended IV

- `encryptAesGcm` generates a **random 12-byte IV per chunk**, encrypts the chunk, and returns `IV || ciphertext` as a single buffer. `decryptAesGcm` splits the first 12 bytes as the IV and decrypts the remainder. Per-chunk IVs mean each chunk's nonce is unique. [`repo://src/utils/crypto.ts#L26-L41`], [`repo://src/utils/crypto.ts#L78-L93`]
- The sender encrypts each chunk before framing it as a `Message` with the file id; the receiver decrypts each chunk after decoding, before accumulating bytes into the file blob. [`repo://src/components/sender/Sender.svelte#L86-L107`], [`repo://src/components/receiver/Receiver.svelte#L74-L92`]
- GCM provides authenticated encryption: a corrupted or tampered chunk fails `decrypt` and surfaces as a channel error rather than silently producing corrupt output.

## Key serialization

- RSA public keys are exported/imported as **SPKI DER, base64-encoded** (`exportKey('spki')` → `btoa`; `importKey('spki')` with `rsaGenParams`, usage `['encrypt']`). The 12-byte AES raw key is base64-URL-encoded only when it must cross the wire as a string parameter — in practice it travels as raw bytes inside the proto `MetaData.key` bytes field after RSA wrapping. [`repo://src/utils/crypto.ts#L96-L126`]
- `arrayBufferToBase64` / `base64ToArrayBuffer` are the shared codec helpers for the SPKI export path. [`repo://src/utils/crypto.ts#L96-L117`]

## Opt-out and failure behavior

- **Encryption is off by default** (`DEFAULT_SEND_OPTIONS.isEncrypt: false`). When off, no RSA keys are generated, `MetaData.key` stays empty, and `sendBuffer` sends plaintext chunks — the code paths simply skip every crypto call. [`repo://src/configs.ts#L20-L24`], [`repo://src/components/sender/Sender.svelte#L86-L107`]
- Defensive fallbacks: `sendBuffer` sends a plaintext chunk if `isEncrypt` is true but the per-file `aesKey` is somehow missing; the receiver decrypts only when both `isEncrypt` and the file's `aesKey` are present. [`repo://src/components/sender/Sender.svelte#L86-L99`], [`repo://src/components/receiver/Receiver.svelte#L86-L88`]
- **Key-exchange validation is explicit, not fire-and-forget.** The receive page imports the `p`-param key with a `catch` that downgrades `isEncrypt` to `false`, toasts "Invalid encryption key in link, falling back to plaintext", and resolves `undefined` — so the session silently degrades instead of advertising encryption while sending nothing usable. The offer page wraps its answer-code key import in `try/catch`: a malformed or truncated answer code toasts "Invalid encryption key in answer code" and aborts before `setRemoteDescription`, instead of leaving a half-configured connection. [`repo://src/components/ReceivePage.svelte#L46-L59`], [`repo://src/components/OfferPage.svelte#L141-L155`]

## Threat model notes

- This layer protects **file content confidentiality and integrity against SDP-link interception** (passive MITM), not against an active attacker who can modify the shared link or answer code end-to-end (they could swap public keys).
- RSA-OAEP-1024 key wrapping caps the wrapped key size and limits brute-force resistance vs. 2048-bit RSA; the payload security is bounded by AES-256-GCM. [`repo://src/utils/crypto.ts#L1-L6`]
