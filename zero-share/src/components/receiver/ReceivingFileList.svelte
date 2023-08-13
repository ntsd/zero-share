<script lang="ts">
  import { FileStatus, type ReceivingFile } from '../../type';
  import FileCard from '../FileCard.svelte';

  export let receivingFiles: { [key: string]: ReceivingFile };
  export let onRemove: (key: string) => void;
  export let onDownload: (key: string) => void;
  export let onAccept: (key: string) => void;
  export let onDeny: (key: string) => void;
</script>

<div class="grid gap-8">
  {#each Object.entries(receivingFiles) as [key, receivedFile], index (key)}
    <FileCard fileDetail={receivedFile} isSender={false}>
      <div class="flex-none">
        {#if receivedFile.status === FileStatus.WaitingAccept && !receivedFile.error}
          <button on:click={() => onAccept(key)} class="btn btn-primary">Accept</button>
          <button on:click={() => onDeny(key)} class="btn btn-ghost">Deny</button>
        {:else}
          {#if receivedFile.status === FileStatus.Success}
            <button on:click={() => onDownload(key)} class="btn btn-primary"> Download </button>
          {/if}
          <button on:click={() => onRemove(key)} class="btn btn-error"> Remove </button>
        {/if}
      </div>
    </FileCard>
  {/each}
</div>
