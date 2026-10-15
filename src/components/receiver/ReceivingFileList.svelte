<script lang="ts">
  import { FileStatus, type FileDetail } from '../../type';
  import FileCard from '../FileCard.svelte';

  type Props = {
    receivingFiles: { [key: string]: FileDetail };
    onRemove: (key: string) => void;
    onDownload: (key: string) => void;
    onAccept: (key: string) => void;
    onDeny: (key: string) => void;
  };

  const { receivingFiles, onRemove, onDownload, onAccept, onDeny }: Props = $props();
</script>

<div class="grid gap-8">
  {#each Object.entries(receivingFiles) as [key, receivedFile] (key)}
    <FileCard fileDetail={receivedFile} isSender={false}>
      <div class="flex-none">
        <!-- Metadata that failed in manual-accept mode (key decrypt / max-size
             validation) leaves the entry in WaitingAccept with `error` set. It must
             stay actionable — Accept after fixing the cause, or Deny/Remove to
             signal the sender — instead of dead-ending on Remove only. The error
             itself still shows via FileCard's error banner. -->
        {#if receivedFile.status === FileStatus.WaitingAccept}
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
