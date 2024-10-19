<script lang="ts">
  import { defaultSendOptions, stunServers } from '../configs';
  import type { SendOptions } from '../type';
  import CustomSelect from './CustomSelect.svelte';

  type Props = {
    onUpdate: (options: SendOptions) => void;
  };
  const { onUpdate }: Props = $props();

  let encryptionEnabled = $state(defaultSendOptions.isEncrypt ? 'true' : 'false');
  let chunkSize: number = $state(defaultSendOptions.chunkSize);
  let iceServer: string = $state(defaultSendOptions.iceServer);

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
      <option value={8 * 1024}>8kb</option>
      <option value={16 * 1024}>16kb</option>
      <option value={32 * 1024}>32kb</option>
      <option value={64 * 1024}>64kb</option>
      <option value={128 * 1024}>128kb</option>
    </select>
  </div>

  <div class="flex flex-row justify-between items-center">
    <div>
      <span class="text-sm">ICE Server</span>
      <p class="text-xs text-gray-500">Choose the STUN/TURN server for connection establishment.</p>
    </div>
  </div>

  <div class="flex flex-row justify-between items-center">
    <CustomSelect options={stunServers} customTextEnabled={true} bind:value={iceServer} />
  </div>
</div>
