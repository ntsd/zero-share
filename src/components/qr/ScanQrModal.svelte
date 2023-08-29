<script lang="ts">
  import type { QrcodeSuccessCallback, QrcodeErrorCallback } from 'html5-qrcode';
  import { Html5Qrcode } from 'html5-qrcode/esm/html5-qrcode';
  import { onMount } from 'svelte';

  let isModalOpen = false;
  let html5Qrcode: Html5Qrcode;
  export let onScanSuccess: (data: string) => void;

  onMount(() => {
    html5Qrcode = new Html5Qrcode('reader');
  });

  // Square QR box with edge size = 70% of the smaller edge of the viewfinder.
  let qrboxFunction = function (viewfinderWidth: number, viewfinderHeight: number) {
    let minEdgePercentage = 0.7; // 70%
    let minEdgeSize = Math.min(viewfinderWidth, viewfinderHeight);
    let qrboxSize = Math.floor(minEdgeSize * minEdgePercentage);
    return {
      width: qrboxSize,
      height: qrboxSize
    };
  };

  function start() {
    html5Qrcode.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        qrbox: qrboxFunction
      },
      onScanSuccessCallback,
      onScanFailure
    );
  }

  async function stop() {
    await html5Qrcode.stop();
  }

  const onScanSuccessCallback: QrcodeSuccessCallback = (decodedText, result) => {
    isModalOpen = false;
    onScanSuccess(decodedText);
  };

  const onScanFailure: QrcodeErrorCallback = (errorMessage, error) => {};
</script>

<label for="scan-qr-modal" class="btn gap-2"> Scan QR Code </label>

<input
  type="checkbox"
  id="scan-qr-modal"
  class="modal-toggle"
  bind:checked={isModalOpen}
  on:change={() => {
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
    <reader class="w-96 max-w-full h-auto" id="reader" />
  </label>
</label>
