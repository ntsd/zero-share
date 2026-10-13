import { QRByte, Encoder, ErrorCorrectionLevel } from '@nuintun/qrcode';

/**
 * Build the data-URL image for `data` as a pure function of its input, so
 * callers can re-derive the QR whenever the underlying value changes
 * (e.g. a freshly generated offer link) instead of caching a mount-time copy.
 */
export function buildQrDataUrl(data: string): string {
  return new Encoder({
    encodingHint: true,
    errorCorrectionLevel: ErrorCorrectionLevel.M,
    version: 0 // 0 for automatic version
  })
    .write(
      new QRByte(data, (value: string) => {
        // The encoding value must be a valid ECI value
        // Custom ECI only support QRByte mode
        // https://github.com/zxing/zxing/blob/master/core/src/main/java/com/google/zxing/common/CharacterSetECI.java
        const bytes = value.split('').map((char) => char.charCodeAt(0));

        return {
          bytes,
          encoding: 27 // 27 is US-ASCII
        };
      })
    )
    .make()
    .toDataURL();
}
