<script lang="ts">
  import FileCard from './FileCard.svelte';

  export let receivingFiles: { [key: string]: ReceivingFile };
  export let onRemove: (key: string) => void;
  export let onDownload: (key: string) => void;
</script>

<div class="grid gap-8">
  {#each Object.entries(receivingFiles) as [key, receivedFile], index (key)}
    <FileCard fileDetail={receivedFile} isSender={false}>
      <div class="flex-none">
        <!-- <button class="btn btn-ghost">Deny</button>
        <button class="btn btn-primary">Accept</button> -->
        {#if receivedFile.success}
          <button on:click={() => onDownload(key)} class="btn btn-primary"> Download </button>
        {/if}
        <button on:click={() => onRemove(key)} class="btn btn-error"> Remove </button>
      </div>
    </FileCard>
  {/each}
</div>
