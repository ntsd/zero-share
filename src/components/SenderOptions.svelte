<script lang="ts">
  import type { SendOptions } from "../type";

  let encryptionEnabled = 'true';
  let chunkSize: number = 16 * 1024;

  function getEncryptionEnabled(): boolean {
    return encryptionEnabled === 'true';
  }

  export let onUpdate: (options: SendOptions) => void;

  function onChange() {
    onUpdate({
      encryptionEnabled: getEncryptionEnabled(),
      chunkSize
    });
  }
</script>

<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
  <label class="label">
    <div>
      <span class="text-sm">Encryption</span>
      <p class="text-xs text-gray-500">
        Enable E2E encryption for a more secure but slower transfer process.
      </p>
    </div>
    <select bind:value={encryptionEnabled} on:change={onChange} class="select select-bordered">
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  </label>

  <label class="label">
    <div>
      <span class="text-sm">Chunk size</span>
      <p class="text-xs text-gray-500">
        Higher will make the file transfer faster but might cause buffer issues.
      </p>
    </div>
    <select bind:value={chunkSize} on:change={onChange} class="select select-bordered">
      <option value={8 * 1024}>16kb</option>
      <option value={16 * 1024}>16kb</option>
      <option value={32 * 1024}>32kb</option>
      <option value={64 * 1024}>64kb</option>
      <option value={128 * 1024}>128kb</option>
    </select>
  </label>
</div>
