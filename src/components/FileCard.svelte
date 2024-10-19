<script lang="ts">
  import { FileStatus, type FileDetail } from '../type';
  import { humanFileSize } from '../utils/humanFIleSize';

  type Props = {
    fileDetail: FileDetail;
    isSender: boolean;
    children: () => any;
  };
  const { fileDetail, isSender, children }: Props = $props();
</script>

<div class="card bg-base-100 shadow-lg shadow-base-300">
  <div class="card-body p-4 text-xs xl:text-sm">
    <div class="grid gap-2 grid-cols-4 items-center">
      <div class="col-span-4">
        <p><strong>Name:</strong> {fileDetail.metaData.name}</p>
        <p><strong>Size:</strong> {humanFileSize(fileDetail.metaData.size)}</p>
        {#if fileDetail.metaData.type}
          <p><strong>Type:</strong> {fileDetail.metaData.type}</p>
        {/if}
      </div>
      <div class="col-span-4">
        <div class="text-center">
          {#if fileDetail.status === FileStatus.Processing}
            {#if isSender}
              Sending: {humanFileSize(fileDetail.bitrate)}/sec
            {:else}
              Receiving: {humanFileSize(fileDetail.bitrate)}/sec
            {/if}
          {:else if fileDetail.error}
            <div class="text-error">
              Error: {fileDetail.error.message}
            </div>
          {:else if fileDetail.status === FileStatus.WaitingAccept}
            Waiting Accept
          {:else if fileDetail.status === FileStatus.Success}
            Success
          {:else}
            Pending
          {/if}
        </div>
        <progress
          value={isNaN(fileDetail.progress) ? 100 : fileDetail.progress}
          max="100"
          class="progress progress-accent"
        ></progress>
      </div>
      <div class="col-span-4 flex justify-end">
        {@render children?.()}
      </div>
    </div>
  </div>
</div>
