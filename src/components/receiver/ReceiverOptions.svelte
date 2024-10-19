<script lang="ts">
  import { defaultReceiveOptions } from '../../configs';
  import type { ReceiveOptions } from '../../type';

  type Props = {
    onUpdate: (options: ReceiveOptions) => void;
  };

  let { onUpdate }: Props = $props();

  let autoAccept = $state(defaultReceiveOptions.autoAccept ? 'true' : 'false');
  let maxSize = $state(defaultReceiveOptions.maxSize);

  function getAutoAccept(): boolean {
    return autoAccept === 'true';
  }

  function onChange() {
    onUpdate({
      autoAccept: getAutoAccept(),
      maxSize: maxSize
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
    <select bind:value={maxSize} onchange={onChange} class="select select-bordered">
      <option value={10 * 1024}>10 MB</option>
      <option value={100 * 1024}>100 MB</option>
      <option value={1024 * 1024 * 1024}>1 GB</option>
      <option value={10 * 1024 * 1024 * 1024}>10 GB</option>
      <option value={1024 * 1024 * 1024 * 1024}>Unlimit</option>
    </select>
  </div>
</div>
