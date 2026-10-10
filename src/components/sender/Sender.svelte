<script lang="ts">
  import DragAndDrop from './DragAndDrop.svelte';
  import EventEmitter from 'eventemitter3';
  import { FileStatus, type FileStats, type SendingFile } from '../../type';
  import SendingFileList from './SendingFileList.svelte';
  import { encryptAesGcm, encryptAesKeyWithRsaPublicKey, generateAesKey } from '../../utils/crypto';
  import { validateFileMetadata } from '../../utils/validator';
  import { Message, MetaData, ReceiveEvent, receiveEventToJSON } from '../../proto/message';
  import { addToastMessage } from '../../stores/toastStore';
  import { PROGRESS_UPDATE_UI_STEP, WAIT_ACCEPT_TIMEOUT } from '../../configs';

  type Props = {
    dataChannel: RTCDataChannel;
    chunkSize: number;
    isEncrypt: boolean;
    rsaPub: CryptoKey | undefined;
  };

  const { dataChannel, chunkSize, isEncrypt, rsaPub }: Props = $props();

  let sendingFiles: { [key: string]: SendingFile } = $state({});

  // Per-file timers started in WaitingAccept; a file must clear its timer on
  // any exit from that status (accept/reject/validate error/remove/close) so
  // the timeout never fires for a file that already moved on.
  let waitAcceptTimers: { [key: string]: ReturnType<typeof setTimeout> } = {};

  function clearWaitAcceptTimer(key: string) {
    if (waitAcceptTimers[key]) {
      clearTimeout(waitAcceptTimers[key]);
      delete waitAcceptTimers[key];
    }
  }

  // Fail a file stuck in WaitingAccept back to Pending so the Send/Resend
  // buttons reappear in SendingFileList; mirrors the REJECT/VALIDATE_ERROR
  // handlers below.
  function failWaitingAccept(key: string, message: string) {
    sendingFiles[key].error = new Error(message);
    sendingFiles[key].status = FileStatus.Pending;
    addToastMessage(`File ${sendingFiles[key].metaData.name} failed: ${message}`, 'error');
  }

  // The sender's only way out of WaitingAccept is a receiver event on the data
  // channel; if the receiver fails RSA key decryption it replies with nothing
  // local-only, and a closed tab replies with nothing at all — so a reply that
  // never arrives is indistinguishable from a receiver that gave up. This
  // timeout bounds that wait.
  function startWaitAcceptTimer(key: string) {
    clearWaitAcceptTimer(key);
    waitAcceptTimers[key] = setTimeout(() => {
      delete waitAcceptTimers[key];
      if (sendingFiles[key]?.status !== FileStatus.WaitingAccept) {
        return; // accepted/rejected/removed in the meantime
      }
      failWaitingAccept(key, 'No response from receiver (timed out waiting for accept)');
    }, WAIT_ACCEPT_TIMEOUT);
  }

  // Data channel went down (receiver tab closed / WebRTC disconnected): fail
  // every pending WaitingAccept file the same way the timeout does.
  export function onChannelClose() {
    for (const key of Object.keys(waitAcceptTimers)) {
      clearWaitAcceptTimer(key);
      if (sendingFiles[key]?.status === FileStatus.WaitingAccept) {
        failWaitingAccept(key, 'Disconnected from receiver');
      }
    }
  }

  export function onReceiveEvent(id: string, receiveEvent: ReceiveEvent) {
    const sendingFile = sendingFiles[id];
    if (sendingFile && sendingFile.event) {
      sendingFile.event.emit(receiveEventToJSON(receiveEvent));
    }
  }

  async function onSend(key: string) {
    const sendingFile = sendingFiles[key];
    let offset = 0;

    const fileStats: FileStats = {
      progress: 0,
      startTime: Date.now(),
      nextProgressUpdate: 0
    };

    // reset value
    sendingFiles[key].error = undefined;
    sendingFiles[key].stop = false;

    sendingFiles[key].event = new EventEmitter();

    sendingFiles[key].event?.on(
      receiveEventToJSON(ReceiveEvent.EVENT_RECEIVER_ACCEPT),
      async () => {
        clearWaitAcceptTimer(key);
        sendingFiles[key].status = FileStatus.Processing;
        sendingFiles[key].startTime = Date.now();
        await sendNextChunk();
      }
    );
    sendingFiles[key].event?.on(receiveEventToJSON(ReceiveEvent.EVENT_RECEIVED_CHUNK), async () => {
      if (sendingFiles[key].stop) {
        return;
      }
      if (sendingFiles[key].error || sendingFiles[key].status != FileStatus.Processing) {
        sendingFiles[key].progress = 0;
        sendingFiles[key].status = FileStatus.Pending;
        sendingFiles[key].stop = false;
        return;
      }

      if (offset < sendingFile.metaData.size) {
        await sendNextChunk();
        return;
      }

      sendingFiles[key].status = FileStatus.Success;
      addToastMessage(`File ${sendingFile.metaData.name} sent successfully`, 'success');
    });

    sendingFiles[key].event?.on(receiveEventToJSON(ReceiveEvent.EVENT_VALIDATE_ERROR), () => {
      clearWaitAcceptTimer(key);
      addToastMessage('Receiver validate error', 'error');
      sendingFiles[key].error = new Error('Receiver validate error');
      sendingFiles[key].status = FileStatus.Pending;
    });

    sendingFiles[key].event?.on(receiveEventToJSON(ReceiveEvent.EVENT_RECEIVER_REJECT), () => {
      clearWaitAcceptTimer(key);
      addToastMessage('Receiver reject the file', 'error');
      sendingFiles[key].error = new Error('Receiver reject the file');
      sendingFiles[key].status = FileStatus.Pending;
    });

    async function sendBuffer(buffer: ArrayBuffer) {
      if (isEncrypt) {
        const aesKey = sendingFiles[key].aesKey;
        if (aesKey) {
          const encrypted = await encryptAesGcm(aesKey, buffer);
          dataChannel.send(
            Message.encode({
              id: key,
              chunk: encrypted
            }).finish()
          );
          return;
        }
      }

      dataChannel.send(
        Message.encode({
          id: key,
          chunk: new Uint8Array(buffer)
        }).finish()
      );
    }

    async function sendNextChunk() {
      const slice = sendingFile.file.slice(offset, offset + chunkSize);
      const buffer = await slice.arrayBuffer();

      // defensive guard: an empty chunk while bytes remain means chunkSize is
      // invalid (e.g. NaN/0 from a crafted `c` URL param); aborting here
      // prevents an infinite loop of empty chunk sends
      if (buffer.byteLength === 0 && offset < sendingFile.metaData.size) {
        sendingFiles[key].error = new Error('Invalid chunk size');
        sendingFiles[key].status = FileStatus.Pending;
        addToastMessage(`File ${sendingFile.metaData.name} failed: invalid chunk size`, 'error');
        return;
      }

      await sendBuffer(buffer);

      offset += buffer.byteLength;

      // calculate progress
      fileStats.progress = Math.round((offset / sendingFile.metaData.size) * 100);
      if (fileStats.progress >= fileStats.nextProgressUpdate) {
        // update UI
        sendingFiles[key].progress = fileStats.progress;
        // calculate bitrate and update UI
        sendingFiles[key].bitrate = Math.round(
          offset / ((Date.now() - fileStats.startTime) / 1000)
        );
        // schedule next update
        fileStats.nextProgressUpdate += PROGRESS_UPDATE_UI_STEP;
        if (fileStats.nextProgressUpdate > 100) {
          fileStats.nextProgressUpdate = 100;
        }
      }
    }

    // send meta data
    dataChannel.send(
      Message.encode({
        id: key,
        metaData: sendingFile.metaData
      }).finish()
    );

    sendingFiles[key].status = FileStatus.WaitingAccept;
    startWaitAcceptTimer(key);
    // TODO: wait finish to send 1 by 1 file (success, error)
  }

  async function sendAllFiles() {
    for (const key of Object.keys(sendingFiles)) {
      if (sendingFiles[key].status != FileStatus.Pending || sendingFiles[key].error) {
        continue;
      }
      await onSend(key);
    }
  }

  async function onStop(key: string) {
    sendingFiles[key].stop = true;
  }

  async function onContinue(key: string) {
    sendingFiles[key].stop = false;
    sendingFiles[key].event?.emit(receiveEventToJSON(ReceiveEvent.EVENT_RECEIVED_CHUNK));
  }

  function onRemove(key: string) {
    clearWaitAcceptTimer(key);
    if (sendingFiles[key].status === FileStatus.Processing) {
      sendingFiles[key].stop = true;
    }
    delete sendingFiles[key];
    sendingFiles = sendingFiles; // do this to trigger update the map
  }

  function onFilesPick(files: FileList) {
    Array.from(files).forEach(async (file) => {
      let aesKey;
      let aesEncrypted = new Uint8Array();
      if (isEncrypt && rsaPub) {
        aesKey = await generateAesKey();
        aesEncrypted = await encryptAesKeyWithRsaPublicKey(rsaPub, aesKey);
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
    });
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
