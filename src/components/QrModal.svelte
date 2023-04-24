<script lang="ts">
  import { Encoder, QRByte } from '@nuintun/qrcode';
  import QrIcon from './QrIcon.svelte';

  export let title: string;
  export let qrValue: string;
  let qrcode: Encoder;

  function genQR() {
    qrcode = new Encoder();
    qrcode.write(new QRByte(qrValue));
    qrcode.make();
  }

  genQR();
</script>

<label for="qr-modal" class="btn gap-2">
  <QrIcon />
  QR Code
</label>

<input type="checkbox" id="qr-modal" class="modal-toggle" />
<label for="qr-modal" class="modal cursor-pointer">
  <label class="modal-box relative flex flex-col justify-center items-center w-auto" for="">
    <h3 class="text-lg font-bold">{title}</h3>
    <img class="w-screen" src={qrcode.toDataURL()} alt="qr" />
  </label>
</label>
