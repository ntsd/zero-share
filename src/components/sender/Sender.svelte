<script lang="ts">
  import DragAndDrop from './DragAndDrop.svelte';
  import EventEmitter from 'eventemitter3';
  import { FileStatus, type FileStats, type SendingFile } from '../../type';
  import SendingFileList from './SendingFileList.svelte';
  import { encryptAesGcm, encryptAesKeyWithRsaPublicKey, generateAesKey } from '../../utils/crypto';
  import { validateFileMetadata } from '../../utils/validator';
  import { Message, MetaData, ReceiveEvent, receiveEventToJSON } from '../../proto/message';
  import { addToastMessage } from '../../stores/toastStore';
  import { PROGRESS_UPDATE_UI_STEP } from '../../configs';

  type Props = {
    dataChannel: RTCDataChannel;
    chunkSize: number;
    isEncrypt: boolean;
    rsaPub: CryptoKey | undefined;
  };

  const { dataChannel, chunkSize, isEncrypt, rsaPub }: Props = $props();

  let sendingFiles: { [key: string]: SendingFile } = $state({});

  // Flipped by onChannelClose() (fired from the page's dataChannel
  // onclose/onerror) or by send() when a send throws. Once true the channel
  // will never deliver anything again, so in-flight/queued chunk pipelines
  // must exit quietly instead of surfacing misleading per-chunk errors.
  let connectionLost = false;

  // Guarded channel send: readyState first, and a closed/closing channel that
  // slips past the check (the close settles asynchronously) is caught here
  // instead of escaping as an InvalidStateError — the pre-fix failure mode,
  // where a dead channel read as "Failed to send chunk: InvalidStateError..."
  // or "Failed to encode file metadata" while the real cause was connection
  // loss.
  function send(message: Uint8Array): boolean {
    if (connectionLost || dataChannel.readyState !== 'open') {
      return false;
    }
    try {
      dataChannel.send(message);
      return true;
    } catch {
      connectionLost = true;
      return false;
    }
  }

  // Fired by the owning page's dataChannel onclose/onerror: mark every file
  // that cannot complete any more with an accurate "connection lost" error
  // (a single toast per file, not one per in-flight chunk) and stop the
  // in-flight send pipelines. Waiting-accept and pending files keep their
  // state — the error is only meaningful once a transfer started.
  export function onChannelClose() {
    if (connectionLost) return;
    connectionLost = true;
    for (const key of Object.keys(sendingFiles)) {
      const f = sendingFiles[key];
      if (!f || f.status === FileStatus.Success) continue;
      if (f.status === FileStatus.Processing) {
        // stop any in-flight sendBuffer/sendNextChunk continuation
        f.stop = true;
      }
      f.error = new Error('Connection lost — transfer aborted');
      f.status = FileStatus.Pending;
      f.progress = 0;
      addToastMessage(`File ${f.metaData.name}: connection lost — transfer aborted`, 'error');
    }
    sendingFiles = sendingFiles; // do this to trigger update the map
  }

  export function onReceiveEvent(id: string, receiveEvent: ReceiveEvent) {
    const sendingFile = sendingFiles[id];
    if (sendingFile && sendingFile.event) {
      sendingFile.event.emit(receiveEventToJSON(receiveEvent));
    }
  }

  async function onSend(key: string) {
    // Capture the entry once and null-guard: the chunk pipeline is driven by
    // async continuations that can outlive a Remove (see sendBuffer /
    // sendNextChunk), so the pipeline only ever dereferences this captured
    // reference, never a live `sendingFiles[key]` re-read after an await.
    const sendingFile = sendingFiles[key];
    if (!sendingFile) return;
    let offset = 0;

    const fileStats: FileStats = {
      progress: 0,
      startTime: Date.now(),
      nextProgressUpdate: 0
    };

    // reset value
    sendingFile.error = undefined;
    sendingFile.stop = false;

    sendingFile.event = new EventEmitter();

    // Shared bookkeeping for a failed sendNextChunk() from either the ACCEPT
    // or RECEIVED_CHUNK path. Defense in depth (same intent as #46/#45): never
    // let a chunk failure escape as an unhandled rejection from the async
    // listener. Only reachable for a send that threw while the channel was
    // still nominally open (send() no-ops on a dead channel and the pipeline
    // is stopped by onChannelClose(), so a connection loss is never misread
    // as a chunk failure).
    function markChunkFailed(err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const entry = sendingFiles[key];
      if (entry && entry.status !== FileStatus.Success && !entry.stop) {
        entry.error = new Error(`Failed to send chunk: ${message}`);
        entry.status = FileStatus.Pending;
        addToastMessage(`File ${sendingFile.metaData.name} failed to send: ${message}`, 'error');
      }
    }

    sendingFile.event?.on(receiveEventToJSON(ReceiveEvent.EVENT_RECEIVER_ACCEPT), async () => {
      // Re-check the live entry after re-entering: the file may have been
      // removed while this async handler was suspended.
      const f = sendingFiles[key];
      if (!f) return;
      f.status = FileStatus.Processing;
      f.startTime = Date.now();
      try {
        await sendNextChunk();
      } catch (err) {
        markChunkFailed(err);
      }
    });
    sendingFile.event?.on(receiveEventToJSON(ReceiveEvent.EVENT_RECEIVED_CHUNK), async () => {
      const f = sendingFiles[key];
      if (!f) return;
      if (f.stop) {
        return;
      }
      if (f.error || f.status != FileStatus.Processing) {
        f.progress = 0;
        f.status = FileStatus.Pending;
        f.stop = false;
        return;
      }

      if (offset < sendingFile.metaData.size) {
        try {
          await sendNextChunk();
        } catch (err) {
          markChunkFailed(err);
        }
        return;
      }

      const f2 = sendingFiles[key];
      if (!f2) return;
      f2.status = FileStatus.Success;
      addToastMessage(`File ${sendingFile.metaData.name} sent successfully`, 'success');
    });

    sendingFile.event?.on(receiveEventToJSON(ReceiveEvent.EVENT_VALIDATE_ERROR), () => {
      addToastMessage('Receiver validate error', 'error');
      const f = sendingFiles[key];
      if (!f) return;
      f.error = new Error('Receiver validate error');
      f.status = FileStatus.Pending;
    });

    sendingFile.event?.on(receiveEventToJSON(ReceiveEvent.EVENT_RECEIVER_REJECT), () => {
      addToastMessage('Receiver reject the file', 'error');
      const f = sendingFiles[key];
      if (!f) return;
      f.error = new Error('Receiver reject the file');
      f.status = FileStatus.Pending;
    });

    async function sendBuffer(buffer: ArrayBuffer) {
      // The entry may have been removed while suspended at an await; the
      // captured `sendingFile` reference (never a live re-read of
      // `sendingFiles[key]`) is safe to dereference after that.
      if (isEncrypt) {
        const aesKey = sendingFile.aesKey;
        if (aesKey) {
          const encrypted = await encryptAesGcm(aesKey, buffer);
          // A Remove during encryption must not fire a send into the void.
          // A dead channel does the same: send() no-ops (no throw), and the
          // file has already been marked "connection lost" by
          // onChannelClose() — the old path threw here and re-fired the
          // failure toast per chunk as "Failed to send chunk: ...".
          if (sendingFile.stop) return;
          send(
            Message.encode({
              id: key,
              chunk: encrypted
            }).finish()
          );
          return;
        }
      }

      if (sendingFile.stop) return;
      send(
        Message.encode({
          id: key,
          chunk: new Uint8Array(buffer)
        }).finish()
      );
    }

    async function sendNextChunk() {
      // Guard up front: no point slicing a file that was removed or stopped.
      if (sendingFile.stop) return;

      // defensive coercion: chunkSize may arrive as a string (e.g. from a
      // <select> bind:value) — a non-number here makes `offset + chunkBytes`
      // concatenate instead of add, sending the whole file remainder as one
      // over-sized chunk
      const parsedChunkSize = Number(chunkSize);
      const chunkBytes =
        Number.isFinite(parsedChunkSize) && parsedChunkSize > 0 ? parsedChunkSize : 32 * 1024;
      const slice = sendingFile.file.slice(offset, offset + chunkBytes);
      const buffer = await slice.arrayBuffer();

      // Re-check after the await: the entry may have been removed or stopped
      // while the slice was being read.
      if (sendingFile.stop) return;

      // defensive guard: an empty chunk while bytes remain means chunkSize is
      // invalid (e.g. NaN/0 from a crafted `c` URL param); aborting here
      // prevents an infinite loop of empty chunk sends
      if (buffer.byteLength === 0 && offset < sendingFile.metaData.size) {
        sendingFile.error = new Error('Invalid chunk size');
        sendingFile.status = FileStatus.Pending;
        addToastMessage(`File ${sendingFile.metaData.name} failed: invalid chunk size`, 'error');
        return;
      }

      await sendBuffer(buffer);

      // A Remove during the send marks stop; don't bookkeep progress into an
      // entry that is (or will be) gone.
      if (sendingFile.stop) return;

      offset += buffer.byteLength;

      // calculate progress
      fileStats.progress = Math.round((offset / sendingFile.metaData.size) * 100);
      if (fileStats.progress >= fileStats.nextProgressUpdate) {
        // update UI
        sendingFile.progress = fileStats.progress;
        // calculate bitrate and update UI
        sendingFile.bitrate = Math.round(offset / ((Date.now() - fileStats.startTime) / 1000));
        // schedule next update
        fileStats.nextProgressUpdate += PROGRESS_UPDATE_UI_STEP;
        if (fileStats.nextProgressUpdate > 100) {
          fileStats.nextProgressUpdate = 100;
        }
      }
    }

    // send meta data: send() guards a dead channel — Resend after the peer
    // disconnected used to throw InvalidStateError here and surface the
    // misleading "Failed to encode file metadata" while the file looped in
    // Pending forever. Now a dead channel yields the accurate connection-lost
    // error; a genuine encode failure still surfaces its own message.
    try {
      const ok = send(
        Message.encode({
          id: key,
          metaData: sendingFile.metaData
        }).finish()
      );
      const f = sendingFiles[key];
      if (!f) return;
      if (ok) {
        f.status = FileStatus.WaitingAccept;
        return;
      }
      // Dead channel: surface the accurate error. onChannelClose() has
      // usually already marked this entry (its toast covers the user); only
      // add here when the entry has no error yet (close never propagated),
      // so one file never gets two connection-lost toasts.
      if (!f.error) {
        f.error = new Error('Connection lost — transfer aborted');
        addToastMessage(
          `File ${sendingFile.metaData.name}: connection lost — transfer aborted`,
          'error'
        );
      }
      f.status = FileStatus.Pending;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const f = sendingFiles[key];
      if (f) {
        f.error = new Error(`Failed to encode file metadata: ${message}`);
        f.status = FileStatus.Pending;
      }
      addToastMessage(`File ${sendingFile.metaData.name} failed: ${message}`, 'error');
    }
    // TODO: wait finish to send 1 by 1 file (success, error)
  }

  async function sendAllFiles() {
    for (const key of Object.keys(sendingFiles)) {
      const f = sendingFiles[key];
      if (!f || f.status != FileStatus.Pending || f.error) {
        continue;
      }
      await onSend(key);
    }
  }

  async function onStop(key: string) {
    const f = sendingFiles[key];
    if (f) f.stop = true;
  }

  async function onContinue(key: string) {
    const f = sendingFiles[key];
    if (!f) return;
    // A dead channel must not re-enter the send pipeline: the resume would
    // emit a synthetic RECEIVED_CHUNK into a handler whose next send would
    // no-op, leaving the entry's stop flag cleared behind a dead connection.
    if (connectionLost) return;
    f.stop = false;
    f.event?.emit(receiveEventToJSON(ReceiveEvent.EVENT_RECEIVED_CHUNK));
  }

  function onRemove(key: string) {
    const f = sendingFiles[key];
    if (!f) return;
    if (f.status === FileStatus.Processing) {
      f.stop = true;
    }
    delete sendingFiles[key];
    sendingFiles = sendingFiles; // do this to trigger update the map
  }

  // async + for...of (not forEach(async ...)): an async callback passed to
  // forEach is fire-and-forget, so a rejection from generateAesKey() or
  // encryptAesKeyWithRsaPublicKey() (rsaPub invalidated between pick and
  // send, e.g. after an offer regeneration) escapes as an unhandled
  // rejection — the file silently vanishes with no toast and no list entry.
  // Every failure path below must instead surface and register the entry.
  async function onFilesPick(files: FileList) {
    for (const file of Array.from(files)) {
      let aesKey;
      let aesEncrypted = new Uint8Array();
      if (isEncrypt) {
        // The peer's RSA public key only exists after the answer is accepted
        // (OfferPage.acceptAnswer), but the drop zone is live as soon as the
        // data channel opens — i.e. while the offer is still pending. The
        // pre-fix guard chained the two conditions in one if, so a pick
        // before acceptAnswer silently skipped key generation and registered
        // `key: new Uint8Array()`, which the receiver's
        // decryptAesKeyWithRsaPrivateKey() rejected, dead-ending the whole
        // encrypted transfer ("Failed to decrypt the file key").
        // Reject the pick with a visible error instead of registering an
        // undeliverable entry, so an empty key can never reach the wire.
        if (!rsaPub) {
          addToastMessage(
            `${file.name} cannot be sent encrypted yet: the peer has not accepted the offer. Accept the answer, then select the file again.`,
            'error'
          );
          continue;
        }
        try {
          aesKey = await generateAesKey();
          aesEncrypted = await encryptAesKeyWithRsaPublicKey(rsaPub, aesKey);
        } catch (err) {
          // Mirror the !rsaPub guard above: surface a visible error and do
          // NOT register the entry. Registering with `key: new Uint8Array()`
          // would let a resend replay that empty key onto the wire and
          // dead-end the receiver exactly like the pre-#66 bug. The key can
          // be regenerated on the next pick, so skipping is loss-free.
          const message = err instanceof Error ? err.message : String(err);
          addToastMessage(`Failed to encrypt the file key for ${file.name}: ${message}`, 'error');
          continue;
        }
      }

      const fileMetaData: MetaData = {
        name: file.name,
        size: file.size,
        type: file.type,
        key: aesEncrypted
      };
      const validateErr = validateFileMetadata(fileMetaData);
      if (validateErr) {
        addToastMessage(`${file.name} ${validateErr.message}`, 'error');
      }

      const id = crypto.randomUUID();
      sendingFiles[id] = {
        file: file,
        metaData: fileMetaData,
        progress: 0,
        bitrate: 0,
        stop: false,
        error: validateErr,
        startTime: 0,
        status: FileStatus.Pending,
        aesKey: aesKey
      };
    }
  }
</script>

<div class="grid gap-4">
  <DragAndDrop {onFilesPick} />
  {#if Object.keys(sendingFiles).length > 0}
    <SendingFileList {sendingFiles} {onRemove} {onSend} {onStop} {onContinue} />
    <button class="btn btn-primary mt-2" onclick={sendAllFiles}>Send all files</button>
  {:else}
    <p class="mt-4">No files selected</p>
  {/if}
</div>
