<script lang="ts">
  import { FileStatus, type SendingFile } from '../../type';
  import FileCard from '../FileCard.svelte';

  export let sendingFiles: { [key: string]: SendingFile };
  export let onRemove: (key: string) => void;
  export let onSend: (key: string) => void;
  export let onStop: (key: string) => void;
  export let onContinue: (key: string) => void;
</script>

<div class="grid gap-4">
  {#each Object.entries(sendingFiles) as [key, sendingFile], index (key)}
    <FileCard fileDetail={sendingFile} isSender={true}>
      <div class="flex-none">
        {#if sendingFile.error}
          <button on:click={() => onSend(key)} class="btn btn-primary"> Resend </button>
        {:else if sendingFile.stop}
          <button on:click={() => onContinue(key)} class="btn btn-secondary"> Continue </button>
        {:else if sendingFile.status === FileStatus.Processing}
          <button on:click={() => onStop(key)} class="btn btn-secondary"> Stop </button>
        {:else if sendingFile.status !== FileStatus.Success && sendingFile.status !== FileStatus.WaitingAccept}
          <button on:click={() => onSend(key)} class="btn btn-primary"> Send </button>
        {/if}
        <button on:click={() => onRemove(key)} class="btn btn-error"> Remove </button>
      </div>
    </FileCard>
  {/each}
</div>
