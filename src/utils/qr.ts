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
 *
 * Overflow fallback: at the fixed `ErrorCorrectionLevel.M` the auto-version
 * encoder caps total data at 18672 bits (~1.8 KB) — larger payloads make the
 * encoder throw a synchronous `Error: data overflow: N > 18672`. This function
 * runs inside a `$derived` during Svelte render (QrModal), so an escape would
 * take down the whole page; we therefore degrade to a static placeholder
 * instead of throwing. The placeholder is a module-level constant so the
 * function stays a pure function of its input (determinism is asserted in
 * tests/qr.test.mjs and tests/qr-overflow.test.mjs).
 */
const QR_OVERFLOW_PLACEHOLDER = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">' +
    '<rect width="256" height="256" fill="white"/>' +
    '<text x="128" y="118" text-anchor="middle" font-family="sans-serif" font-size="18" fill="black">QR too large</text>' +
    '<text x="128" y="142" text-anchor="middle" font-family="sans-serif" font-size="14" fill="black">copy the link instead</text>' +
    '</svg>'
)}`;

export function buildQrDataUrl(data: string): string {
  try {
    return new Encoder({
      encodingHint: true,
      errorCorrectionLevel: ErrorCorrectionLevel.M,
      version: 0 // 0 for automatic version
    })
      .write(new QRByte(data))
      .make()
      .toDataURL();
  } catch {
    // Known shape is the encoder's `data overflow: N > 18672` when `data`
    // exceeds M-level capacity; any other encoder failure also degrades to
    // the placeholder rather than crashing the render.
    return QR_OVERFLOW_PLACEHOLDER;
  }
}
