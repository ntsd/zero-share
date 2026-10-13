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

  // Re-derive whenever qrData changes so the QR always encodes the current
  // link, not the one captured at mount.
  const qrcodeDataUrl = $derived(buildQrDataUrl(qrData));
</script>

<label for="qr-modal" class="btn gap-2"> QR Code </label>

<input type="checkbox" id="qr-modal" class="modal-toggle" bind:checked={isModalOpen} />
<label for="qr-modal" class="modal cursor-pointer">
  <label class="modal-box relative flex flex-col justify-center items-center w-auto" for="">
    <h3 class="text-lg font-bold">{title}</h3>
    <img class="w-screen" src={qrcodeDataUrl} alt="qr" />
  </label>
</label>
