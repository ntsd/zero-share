<script lang="ts">
  import { humanFileSize } from '../utils/humanFIleSize';

  export let fileDetail: FileDetail;
  export let isSender: boolean;
</script>

<div class="card bg-base-100 shadow-xl">
  <div class="card-body">
    <div class="grid gap-4 grid-cols-4 items-center">
      <div class="col-span-4">
        <p><strong>Name:</strong> {fileDetail.metaData.name}</p>
        <p><strong>Size:</strong> {humanFileSize(fileDetail.metaData.size)}</p>
        <p><strong>Type:</strong> {fileDetail.metaData.type}</p>
      </div>
      <div class="col-span-4">
        <div class="text-center">
          {#if fileDetail.processing}
            {#if isSender}
              Sending: {fileDetail.bitrate} kbits/sec
            {:else}
              Receiving: {fileDetail.bitrate} kbits/sec
            {/if}
          {:else if fileDetail.error}
            <div class="text-error">
              Error: {fileDetail.error.message}
            </div>
          {:else if fileDetail.success}
            Success
          {:else}
            Pending
          {/if}
        </div>
        <progress value={fileDetail.progress} max="100" class="progress" />
      </div>
      <div class="col-span-4 flex justify-end">
        <slot />
      </div>
    </div>
  </div>
</div>
