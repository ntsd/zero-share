<script lang="ts">
  import { QRByte, Encoder, ErrorCorrectionLevel } from '@nuintun/qrcode';

  type Props = {
    title: string;
    qrData: string;
  };

  const { title, qrData }: Props = $props();

  export function close() {
    isModalOpen = false;
  }

  let isModalOpen = $state(false);

  const qrcode: Encoder = new Encoder({
    encodingHint: true,
    errorCorrectionLevel: ErrorCorrectionLevel.M,
    version: 0 // 0 for automatic version
  })
    .write(
      new QRByte(qrData, (data: string) => {
        // The encoding value must a valid ECI value
        // Custom ECI only support QRByte mode
        // https://github.com/zxing/zxing/blob/master/core/src/main/java/com/google/zxing/common/CharacterSetECI.java
        const bytes = data.split('').map((char) => char.charCodeAt(0));

        return {
          bytes: bytes,
          encoding: 27 // 27 is US-ASCII
        };
      })
    )
    .make();
</script>

<label for="qr-modal" class="btn gap-2"> QR Code </label>

<input type="checkbox" id="qr-modal" class="modal-toggle" bind:checked={isModalOpen} />
<label for="qr-modal" class="modal cursor-pointer">
  <label class="modal-box relative flex flex-col justify-center items-center w-auto" for="">
    <h3 class="text-lg font-bold">{title}</h3>
    <img class="w-screen" src={qrcode.toDataURL()} alt="qr" />
  </label>
</label>
