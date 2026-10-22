<script lang="ts">
  import { DEFAULT_RECEIVE_OPTIONS } from '../../configs';
  import type { ReceiveOptions } from '../../type';

  type Props = {
    onUpdate: (options: ReceiveOptions) => void;
  };

  let { onUpdate }: Props = $props();

  let autoAccept = $state(DEFAULT_RECEIVE_OPTIONS.autoAccept ? 'true' : 'false');
  let maxSize = $state(DEFAULT_RECEIVE_OPTIONS.maxSize);

  function getAutoAccept(): boolean {
    return autoAccept === 'true';
  }

  function onChange() {
    // bind:value on a <select> yields the DOM option value (a string); coerce
    // back to a number so ReceiveOptions.maxSize stays a number at runtime.
    const parsed = Number(maxSize);
    onUpdate({
      autoAccept: getAutoAccept(),
      maxSize: Number.isFinite(parsed) ? parsed : DEFAULT_RECEIVE_OPTIONS.maxSize
    });
  }
</script>

<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
  <div class="flex flex-row justify-between items-center">
    <div>
      <span class="text-sm">Auto accept</span>
      <p class="text-xs text-gray-500">The receiver will automatically accept receiving files.</p>
    </div>
    <select bind:value={autoAccept} class="select select-bordered" onchange={onChange}>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  </div>

  <div class="flex flex-row justify-between items-center">
    <div>
      <span class="text-sm">Max Size</span>
      <p class="text-xs text-gray-500">The max file size to allow to send.</p>
    </div>
    <!-- Largest option stays under the classic-ZIP per-entry sentinel
         (0xffffffff ~ 4 GiB): createZipStoreOnly writes no zip64 extra
         fields, so "Download all files (zip)" can never archive an entry of
         4 GiB or larger. Do not offer a value above that without adding
         zip64 support (the old "10 GB"/"Unlimit" (1 TiB) options made the
         bulk zip download silently impossible for their own allowed sizes). -->
    <select bind:value={maxSize} onchange={onChange} class="select select-bordered">
      <option value={10 * 1024 * 1024}>10 MB</option>
      <option value={100 * 1024 * 1024}>100 MB</option>
      <option value={1024 * 1024 * 1024}>1 GB</option>
      <option value={2 * 1024 * 1024 * 1024}>2 GB</option>
    </select>
  </div>
</div>
