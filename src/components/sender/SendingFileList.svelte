<script lang="ts">
  import { FileStatus, type SendingFile } from '../../type';
  import FileCard from '../FileCard.svelte';

  type Props = {
    sendingFiles: { [key: string]: SendingFile };
    // Dead-channel flag from the owning Sender (onChannelClose() / a throwing
    // send()). Once the channel is lost, no entry on this peer can ever be
    // sent — there is no reconnection path — so Resend must not be offered:
    // it would be a guaranteed silent no-op. Only Remove is meaningful then.
    connectionLost: boolean;
    onRemove: (key: string) => void;
    onSend: (key: string) => void;
    onStop: (key: string) => void;
    onContinue: (key: string) => void;
  };
  const { sendingFiles, connectionLost, onRemove, onSend, onStop, onContinue }: Props = $props();
</script>

<div class="grid gap-4">
  {#each Object.entries(sendingFiles) as [key, sendingFile] (key)}
    <FileCard fileDetail={sendingFile} isSender={true}>
      <div class="flex-none">
        <!-- With the channel lost, Resend can never succeed (send() no-ops on
             a dead channel and onSend just re-stamps the same error), so the
             entry shows Remove only — the error banner stays via FileCard.
             On a live channel, transiently failed entries keep a working
             Resend. -->
        {#if sendingFile.error && !connectionLost}
          <button onclick={() => onSend(key)} class="btn btn-primary"> Resend </button>
        {:else if sendingFile.stop}
          <button onclick={() => onContinue(key)} class="btn btn-secondary"> Continue </button>
        {:else if sendingFile.status === FileStatus.Processing}
          <button onclick={() => onStop(key)} class="btn btn-secondary"> Stop </button>
        {:else if sendingFile.status !== FileStatus.Success && sendingFile.status !== FileStatus.WaitingAccept}
          <button onclick={() => onSend(key)} class="btn btn-primary"> Send </button>
        {/if}
        <button onclick={() => onRemove(key)} class="btn btn-error"> Remove </button>
      </div>
    </FileCard>
  {/each}
</div>
