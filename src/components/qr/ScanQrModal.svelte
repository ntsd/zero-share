<script module>
  let scanQrModalCounter = 0;
</script>

<script lang="ts">
  import QrScanner from 'qr-scanner';
  import { onMount } from 'svelte';

  type Props = {
    onScanSuccess: (data: string) => void;
  };

  const { onScanSuccess }: Props = $props();

  // Per-instance ids so multiple ScanQrModal instances on one page don't share toggles
  // or camera video elements.
  const id = `scan-qr-modal-${++scanQrModalCounter}`;
  const videoId = `qr-reader-${scanQrModalCounter}`;

  let isModalOpen = $state(false);
  let qrScanner: QrScanner | undefined = $state(undefined);

  onMount(() => {
    qrScanner = new QrScanner(
      document.getElementById(videoId) as HTMLVideoElement,
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

<label for={id} class="btn gap-2"> Scan QR Code </label>

<input
  type="checkbox"
  {id}
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
<label for={id} class="modal cursor-pointer">
  <div class="modal-box relative flex flex-col justify-center items-center p-2 w-fit max-w-none">
    <h3 class="text-lg font-bold">Scan QR Code</h3>
    <video class="w-96 max-w-full h-auto visible" id={videoId}> </video>
  </div>
</label>
