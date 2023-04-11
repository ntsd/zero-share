<script lang="ts">
  let autoApprove = 'true';

  function getAutoApprove(): boolean {
    return autoApprove === 'true';
  }

  export let onUpdate: (options: ReceiveOptions) => void;

  function onChange() {
    onUpdate({
      autoAccept: getAutoApprove()
    });
  }
</script>

<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
  <label class="label">
    <dic>
      <span class="text-sm">Auto approve</span>
      <p class="text-xs text-gray-500">The receiver will automatically approve receiving files.</p>
    </dic>
    <select bind:value={autoApprove} class="select select-bordered" on:change={onChange}>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  </label>
</div>
