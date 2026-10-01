<script lang="ts">
  import { CHUNK_SIZE_OPTIONS, DEFAULT_SEND_OPTIONS, STUN_SERVERS } from '../configs';
  import type { SendOptions } from '../type';
  import CustomSelect from './CustomSelect.svelte';

  type Props = {
    onUpdate: (options: SendOptions) => void;
  };
  const { onUpdate }: Props = $props();

  let encryptionEnabled = $state(DEFAULT_SEND_OPTIONS.isEncrypt ? 'true' : 'false');
  let chunkSize: number = $state(DEFAULT_SEND_OPTIONS.chunkSize);
  let iceServer: string = $state(DEFAULT_SEND_OPTIONS.iceServer);

  function getEncryptionEnabled(): boolean {
    return encryptionEnabled === 'true';
  }

  function onChange() {
    onUpdate({
      isEncrypt: getEncryptionEnabled(),
      chunkSize,
      iceServer
    });
  }
</script>

<div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
  <div class="flex flex-row justify-between items-center">
    <div>
      <span class="text-sm">Encryption</span>
      <p class="text-xs text-gray-500">
        Enable E2E encryption for a more secure but slower transfer.
      </p>
    </div>
    <select bind:value={encryptionEnabled} onchange={onChange} class="select select-bordered">
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  </div>

  <div class="flex flex-row justify-between items-center">
    <div>
      <span class="text-sm">Chunk Size</span>
      <p class="text-xs text-gray-500">Higher make transfer faster but might cause buffer issue.</p>
    </div>
    <select bind:value={chunkSize} onchange={onChange} class="select select-bordered">
      {#each CHUNK_SIZE_OPTIONS as size}
        <option value={size}>{size / 1024}kb</option>
      {/each}
    </select>
  </div>

  <div class="flex flex-row justify-between items-center">
    <div>
      <span class="text-sm">ICE Server</span>
      <p class="text-xs text-gray-500">Choose the STUN/TURN server for connection establishment.</p>
    </div>
  </div>

  <div class="flex flex-row justify-between items-center">
    <CustomSelect options={STUN_SERVERS} customTextEnabled={true} bind:value={iceServer} />
  </div>
</div>
