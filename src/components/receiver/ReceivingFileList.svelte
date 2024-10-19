<script lang="ts">
  import { FileStatus, type ReceivingFile } from '../../type';
  import FileCard from '../FileCard.svelte';

  type Props = {
    receivingFiles: { [key: string]: ReceivingFile };
    onRemove: (key: string) => void;
    onDownload: (key: string) => void;
    onAccept: (key: string) => void;
    onDeny: (key: string) => void;
  };

  const { receivingFiles, onRemove, onDownload, onAccept, onDeny }: Props = $props();
</script>

<div class="grid gap-8">
  {#each Object.entries(receivingFiles) as [key, receivedFile], index (key)}
    <FileCard fileDetail={receivedFile} isSender={false}>
      <div class="flex-none">
        {#if receivedFile.status === FileStatus.WaitingAccept && !receivedFile.error}
          <button onclick={() => onAccept(key)} class="btn btn-primary">Accept</button>
          <button onclick={() => onDeny(key)} class="btn btn-ghost">Deny</button>
        {:else}
          {#if receivedFile.status === FileStatus.Success}
            <button onclick={() => onDownload(key)} class="btn btn-primary"> Download </button>
          {/if}
          <button onclick={() => onRemove(key)} class="btn btn-error"> Remove </button>
        {/if}
      </div>
    </FileCard>
  {/each}
</div>
