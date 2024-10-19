<script lang="ts">
  import QrScanner from 'qr-scanner';
  import { onMount } from 'svelte';

  type Props = {
    onScanSuccess: (data: string) => void;
  };

  const { onScanSuccess }: Props = $props();

  let isModalOpen = $state(false);
  let qrScanner: QrScanner | undefined = $state(undefined);

  onMount(() => {
    qrScanner = new QrScanner(
      document.getElementById('reader') as any,
      (decodedText: QrScanner.ScanResult) => {
        isModalOpen = false;
        onScanSuccess(decodedText.data);
      },
      {}
    );
  });

  function start() {
    qrScanner?.start();
  }

  async function stop() {
    await qrScanner?.stop();
  }
</script>

<label for="scan-qr-modal" class="btn gap-2"> Scan QR Code </label>

<input
  type="checkbox"
  id="scan-qr-modal"
  class="modal-toggle"
  bind:checked={isModalOpen}
  onchange={() => {
    if (isModalOpen) {
      start();
      return;
    }
    stop();
  }}
/>
<label for="scan-qr-modal" class="modal cursor-pointer">
  <label
    class="modal-box relative flex flex-col justify-center items-center p-2 w-fit max-w-none"
    for=""
  >
    <h3 class="text-lg font-bold">Scan QR Code</h3>
    <video class="w-96 max-w-full h-auto" id="reader"> </video>
  </label>
</label>
