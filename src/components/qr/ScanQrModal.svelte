<script lang="ts">
  import QrScanner from 'qr-scanner';
  import { onDestroy, onMount } from 'svelte';

  type Props = {
    onScanSuccess: (data: string) => void;
  };

  const { onScanSuccess }: Props = $props();

  let isModalOpen = $state(false);
  let qrScanner: QrScanner | undefined = $state(undefined);

  onMount(() => {
    qrScanner = new QrScanner(
      document.getElementById('qr-reader') as HTMLVideoElement,
      (decodedText: QrScanner.ScanResult) => {
        isModalOpen = false;
        // Programmatic close: the checkbox change event never fires, so the
        // scanner must be stopped here to release the camera stream + worker.
        stop();
        onScanSuccess(decodedText.data);
      },
      {}
    );
  });

  onDestroy(() => {
    // Release the camera if the component unmounts while a scan is active.
    // stop() is a no-op when the scanner is already stopped.
    stop();
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
  <div class="modal-box relative flex flex-col justify-center items-center p-2 w-fit max-w-none">
    <h3 class="text-lg font-bold">Scan QR Code</h3>
    <video class="w-96 max-w-full h-auto visible" id="qr-reader"> </video>
  </div>
</label>
