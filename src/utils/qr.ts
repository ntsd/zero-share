import { QRByte, Encoder, ErrorCorrectionLevel } from '@nuintun/qrcode';

/**
 * Build the data-URL image for `data` as a pure function of its input, so
 * callers can re-derive the QR whenever the underlying value changes
 * (e.g. a freshly generated offer link) instead of caching a mount-time copy.
 *
 * `new QRByte(data)` with no custom callback uses the library's built-in
 * UTF-8 encoder (surrogate-pair aware) and emits the matching ECI hint
 * (EncodingHint.UTF8 = 26). A bespoke byte/ECI callback previously truncated
 * non-ASCII code points to their low UTF-16 byte and declared a wrong ECI,
 * corrupting any non-ASCII payload; do not reintroduce one.
 */
export function buildQrDataUrl(data: string): string {
  return new Encoder({
    encodingHint: true,
    errorCorrectionLevel: ErrorCorrectionLevel.M,
    version: 0 // 0 for automatic version
  })
    .write(new QRByte(data))
    .make()
    .toDataURL();
}
