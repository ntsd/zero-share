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
  import { createChannelSender } from '../../utils/channelSender';

  type Props = {
    dataChannel: RTCDataChannel;
    chunkSize: number;
    isEncrypt: boolean;
    rsaPub: CryptoKey | undefined;
  };

  const { dataChannel, chunkSize, isEncrypt, rsaPub }: Props = $props();

  let sendingFiles: { [key: string]: SendingFile } = $state({});

  // The guarded channel send (dead-channel flag + readyState check + throwing
  // send catch) lives in the shared src/utils/channelSender.ts helper,
  // deduplicated from the receiver's identical copy — see that file for the
  // full rationale.
  const channelSender = createChannelSender(dataChannel);

  // Dead-channel flag for the SendingFileList's Resend/Continue/Send gating.
  // This is a $state the template reacts to — NOT a $derived over
  // channelSender.isLost(): isLost() reads a plain closure variable in the
  // helper and touches no Svelte signal, so a $derived over it evaluates
  // once, is marked CLEAN, and caches `false` for the whole component
  // lifetime — the gate would never engage after onChannelClose()/a throwing
  // send. The helper stays the single source of truth for the send() guard
  // (pipeline correctness); this is the UI-facing copy the template reads.
  // Flipped below in onChannelClose() and in the send() wrapper.
  let connectionLost = $state(false);
  // Thin wrapper around the helper's guarded send: call sites keep their
  // plain send(...) shape. When the helper flips its lost flag (a throwing
  // send on the close-timing race), mirror it into the UI flag so the gate
  // re-renders — onChannelClose() covers the normal close, this the
  // throw-first race.
  function send(message: Uint8Array): boolean {
    const ok = channelSender.send(message);
    if (channelSender.isLost()) connectionLost = true;
    return ok;
  }

  // Fired by the owning page's dataChannel onclose/onerror: mark every file
  // that cannot complete any more with an accurate "connection lost" error
  // (a single toast per file, not one per in-flight chunk) and stop the
  // in-flight send pipelines. Waiting-accept and pending files keep their
  // state — the error is only meaningful once a transfer started.
  export function onChannelClose() {
    if (channelSender.isLost()) return;
    channelSender.markLost();
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
      // A stop only matters while bytes are still to send: the closure's
      // offset advances as chunks hit the wire, so stop with offset < size
      // is a mid-file pause — bail out as before. But stop with offset >=
      // size means every byte was delivered before the stop clicked (Stop
      // during the final chunk's send/ack window): the completion ack must
      // still finish the entry, or the file stays stuck in Processing and a
      // later Continue re-sends the last chunk, which the receiver's
      // exact-size gate rejects as an overshoot.
      if (f.stop && offset < sendingFile.metaData.size) {
        return;
      }
      // Terminal state: a completed entry must never bounce — a stray or
      // synthetic ack (e.g. one emitted by onContinue from a Continue button
      // that was still rendered when the completion ack raced in) reaching
      // this point would otherwise walk the bounce branch below and demote
      // Success back to Pending.
      if (f.status === FileStatus.Success) {
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
      // A stop click in the final chunk's send/ack window leaves stop=true
      // here; without clearing it, the list renders Continue for a finished
      // entry and a click would bounce it back to Pending through the
      // bounce branch above.
      f2.stop = false;
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
          if (sendingFile.stop) return false;
          // Report wire reality to the caller: this chunk IS on the wire
          // even if stop flipped between encryption finishing and the send,
          // so the caller's offset bookkeeping must cover it.
          send(
            Message.encode({
              id: key,
              chunk: encrypted
            }).finish()
          );
          return true;
        }
      }

      if (sendingFile.stop) return false;
      send(
        Message.encode({
          id: key,
          chunk: new Uint8Array(buffer)
        }).finish()
      );
      return true;
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

      // A stop may flip between the slice being read and here (Remove or
      // Stop clicked mid-flight). The chunk was still put on the wire by
      // sendBuffer() — it returned true only when send() actually ran — so
      // the closure's offset must cover it: skipping the bookkeeping on stop
      // left offset behind the wire after a stop during the final chunk's
      // send/ack window, and a later Continue would re-slice the last bytes
      // and re-send them, which the receiver's exact-size gate rejects as
      // an overshoot on a fully delivered file. Progress UI for a
      // removed/aborted entry is cosmetic: the pipeline stops, so skipping
      // it on stop is safe.
      const sent = await sendBuffer(buffer);
      if (sent) {
        offset += buffer.byteLength;
      }
      if (sendingFile.stop) return;

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
    // A dead channel must not re-enter the send pipeline (same guard as
    // onContinue() above): send() no-ops and the dead-channel branch would
    // re-stamp the connection-lost error + one toast per pending file, so a
    // batch click is a toast-burst no-op — the per-file Send buttons are
    // suppressed by the template gate, this is the code-level backstop.
    if (channelSender.isLost()) return;
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
    if (channelSender.isLost()) return;
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
        // Mirror the crypto guards above: surface a visible error and do
        // NOT register the entry. The shared validator (also enforced by
        // the receiver on the same metadata) rejects size <= 0 /
        // non-finite — a 0-byte file can never complete: the receiver
        // bounces us back with EVENT_VALIDATE_ERROR on every resend, and
        // processChunk's exact-match gate (receivedSize === size) can
        // never be satisfied by an empty payload. Registering it as a
        // Resend-able Pending entry was a guaranteed dead-end that
        // re-fired a "Receiver validate error" toast on every retry, so
        // an undeliverable file never enters sendingFiles at all.
        addToastMessage(`${file.name} ${validateErr.message}`, 'error');
        continue;
      }

      const id = crypto.randomUUID();
      sendingFiles[id] = {
        file: file,
        metaData: fileMetaData,
        progress: 0,
        bitrate: 0,
        stop: false,
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
    <!-- connectionLost is a $state (not a $derived over the helper): the
         template re-renders from its write, on the same close that mutates
         sendingFiles, so the list reads the up-to-date flag. A $derived over
         channelSender.isLost() would be permanently cached `false`. -->
    <SendingFileList {sendingFiles} {connectionLost} {onRemove} {onSend} {onStop} {onContinue} />
    <!-- With the channel lost no entry can ever be sent (send() no-ops on a
         dead channel; a batch click just re-stamps the connection-lost error
         on every pending file), so the batch button is a guaranteed silent
         no-op exactly like the per-file Send/Resend/Continue buttons above
         and is gated on the same connectionLost flag — only Remove stays. -->
    {#if !connectionLost}
      <button class="btn btn-primary mt-2" onclick={sendAllFiles}>Send all files</button>
    {/if}
  {:else}
    <p class="mt-4">No files selected</p>
  {/if}
</div>
