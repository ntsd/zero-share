import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decoder } from '@nuintun/qrcode';
import sharp from 'sharp';

// Regression test for QrModal freezing the QR at mount: the data URL must be
// a pure function of its input so a fresh offer link re-derives a fresh QR
// instead of silently encoding the first one. Node strips the type
// annotations in qr.ts natively (erasable TS syntax).
const here = dirname(fileURLToPath(import.meta.url));
const { buildQrDataUrl } = await import(join(here, '..', 'src', 'utils', 'qr.ts'));

test('buildQrDataUrl returns a data URL', () => {
  const url = buildQrDataUrl('https://example.com/offer?sig=1');
  assert.match(url, /^data:image\/gif;base64,/, 'must be a GIF data URL');
});

test('buildQrDataUrl is pure: same input -> same data URL', () => {
  const a = buildQrDataUrl('https://zero-share.example/offer?sig=abc');
  const b = buildQrDataUrl('https://zero-share.example/offer?sig=abc');
  assert.equal(a, b, 'identical input must yield the identical data URL');
});

test('buildQrDataUrl is pure: different input -> different data URL', () => {
  // Mirrors the OfferPage repro: regenerating the offer replaces offerLink.
  const first = buildQrDataUrl('https://zero-share.example/offer?sig=first-offer');
  const second = buildQrDataUrl('https://zero-share.example/offer?sig=second-offer');
  assert.notEqual(first, second, 'a new offer link must produce a new QR');
});

// Decodes the rendered GIF data URL back to text via sharp (GIF -> RGBA
// pixels) and the library's own Decoder, so the round-trip test proves the
// emitted bytes are correct, not just that a GIF was produced.
async function decodeQrDataUrl(dataUrl) {
  const { data, info } = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4, 'pixel buffer must be RGBA');
  const pixels = new Uint8ClampedArray(data);
  const result = new Decoder().decode(pixels, info.width, info.height);
  assert.ok(result, 'QR image must decode');
  return result.data;
}

test('buildQrDataUrl round-trips a non-ASCII payload (regression: byte truncation + wrong ECI)', async () => {
  // é is a 2-byte UTF-8 code point; 🎉 and 日 are astral/surrogate-pair
  // characters — exactly the inputs the old charCodeAt-based callback
  // corrupted (low byte per UTF-16 unit) and the wrong ECI hint (27)
  // misdescribed.
  const payload = 'https://zero-share.example/offer?sig=café🎉-日本語';
  const decoded = await decodeQrDataUrl(buildQrDataUrl(payload));
  assert.equal(decoded, payload, 'decoded QR must equal the original payload');
});

test('buildQrDataUrl round-trips the ASCII offer-link shape (no behavior regression)', async () => {
  const payload = 'https://zero-share.example/offer?sig=first-offer';
  const decoded = await decodeQrDataUrl(buildQrDataUrl(payload));
  assert.equal(decoded, payload, 'ASCII payloads must still decode byte-for-byte');
});

test('qr.ts source carries no custom QRByte callback', async () => {
  const source = await readFile(join(here, '..', 'src', 'utils', 'qr.ts'), 'utf8');
  assert.match(source, /new QRByte\(data\)/, 'must use the library built-in UTF-8 byte path');
  assert.doesNotMatch(source, /QRByte\(data,\s*\(/, 'no custom byte/ECI callback allowed');
  assert.doesNotMatch(source, /charCodeAt/, 'no hand-rolled per-char byte mapping');
  assert.doesNotMatch(
    source,
    /encoding:\s*27/,
    'no wrong ECI constant (27 is ISO-2022-CN, not US-ASCII)'
  );
});
