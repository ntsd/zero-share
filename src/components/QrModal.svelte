<script lang="ts">
  import { Encoder, QRByte, ErrorCorrectionLevel } from '@nuintun/qrcode';
  import QrIcon from './QrIcon.svelte';

  export let title: string;
  export let qrValue: string;
  export function close() {
    isModalOpen = false;
  }

  let isModalOpen = false;
  let qrcode: Encoder;

  function genQR() {
    qrcode = new Encoder();
    
    qrcode.setEncodingHint(true);
    qrcode.setErrorCorrectionLevel(ErrorCorrectionLevel.H);

    qrcode.write(new QRByte(qrValue));
    qrcode.make();
  }

  genQR();
</script>

<label for="qr-modal" class="btn gap-2">
  <QrIcon />
  QR Code
</label>

<input type="checkbox" id="qr-modal" class="modal-toggle" bind:checked={isModalOpen} />
<label for="qr-modal" class="modal cursor-pointer">
  <label class="modal-box relative flex flex-col justify-center items-center w-auto" for="">
    <h3 class="text-lg font-bold">{title}</h3>
    <img class="w-screen" src={qrcode.toDataURL()} alt="qr" />
  </label>
</label>
