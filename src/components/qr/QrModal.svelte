<script module>
  let qrModalCounter = 0;
</script>

<script lang="ts">
  import { buildQrDataUrl } from '../../utils/qr';

  type Props = {
    title: string;
    qrData: string;
  };

  const { title, qrData }: Props = $props();

  export function close() {
    isModalOpen = false;
  }

  let isModalOpen = $state(false);

  // Per-instance id so multiple QrModal instances on one page don't share a toggle
  const id = `qr-modal-${++qrModalCounter}`;

  // Re-derive whenever qrData changes so the QR always encodes the current
  // link, not the one captured at mount.
  const qrcodeDataUrl = $derived(buildQrDataUrl(qrData));
</script>

<label for={id} class="btn gap-2"> QR Code </label>

<input type="checkbox" {id} class="modal-toggle" bind:checked={isModalOpen} />
<label for={id} class="modal cursor-pointer">
  <label class="modal-box relative flex flex-col justify-center items-center w-auto" for="">
    <h3 class="text-lg font-bold">{title}</h3>
    <img class="w-screen" src={qrcodeDataUrl} alt="qr" />
  </label>
</label>
