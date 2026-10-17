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
        <!-- With the channel lost no entry can ever be sent (send() and
             onContinue() no-op on a dead channel, onSend just re-stamps the
             same error), so Resend, Continue and the never-started Send must
             all be suppressed — each would be a guaranteed silent no-op — and
             only Remove stays, with the error banner via FileCard. On a live
             channel transiently failed entries keep a working Resend. -->
        {#if sendingFile.error && !connectionLost}
          <button onclick={() => onSend(key)} class="btn btn-primary"> Resend </button>
        {:else if sendingFile.stop && !connectionLost}
          <!-- onContinue() no-ops on a dead channel, so Continue is a dead
               button there too; only Remove remains meaningful. -->
          <button onclick={() => onContinue(key)} class="btn btn-secondary"> Continue </button>
        {:else if sendingFile.status === FileStatus.Processing}
          <button onclick={() => onStop(key)} class="btn btn-secondary"> Stop </button>
        {:else if sendingFile.status !== FileStatus.Success && sendingFile.status !== FileStatus.WaitingAccept && !connectionLost}
          <!-- Dead on a lost channel as well: clicking would run onSend(),
               which is a state-preserving no-op there — it only re-stamps the
               connection-lost error and bounces the entry back to Pending.
               After onChannelClose() the entry has an error, so on the next
               render the first condition catches it — only Remove shows. -->
          <button onclick={() => onSend(key)} class="btn btn-primary"> Send </button>
        {/if}
        <button onclick={() => onRemove(key)} class="btn btn-error"> Remove </button>
      </div>
    </FileCard>
  {/each}
</div>
