<script lang="ts">
  import FileCard from './FileCard.svelte';

  export let sendingFiles: { [key: string]: SendingFile };
  export let onRemove: (key: string) => void;
  export let onSend: (key: string) => void;
  export let onStop: (key: string) => void;
</script>

<div class="grid gap-8">
  {#each Object.entries(sendingFiles) as [key, sendingFile], index (key)}
    <FileCard fileDetail={sendingFile} isSender={true}>
      <div class="flex-none">
        {#if sendingFile.processing}
          <button on:click={() => onStop(key)} class="btn btn-primary"> Stop </button>
        {:else}
          <button on:click={() => onSend(key)} class="btn btn-primary"> Send </button>
        {/if}
        <button on:click={() => onRemove(key)} class="btn btn-error"> Remove </button>
      </div>
    </FileCard>
  {/each}
</div>
