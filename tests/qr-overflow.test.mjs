import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decoder } from '@nuintun/qrcode';
import sharp from 'sharp';

// Regression guard for the "data overflow" crash: at ErrorCorrectionLevel.M
// the auto-version encoder caps total data at 18672 bits (~1.8 KB). Larger
// payloads (e.g. an offer link whose base64url SDP + key exceeds that) make
// the encoder throw a synchronous `Error: data overflow: N > 18672`. Since
// buildQrDataUrl runs inside a $derived during Svelte render (QrModal), that
// exception used to take down the whole page; it must now degrade to a
// deterministic placeholder data URL instead.
//
// Node strips the type annotations in qr.ts natively (erasable TS syntax),
// same import pattern as tests/qr.test.mjs.
const here = dirname(fileURLToPath(import.meta.url));
const { buildQrDataUrl } = await import(join(here, '..', 'src', 'utils', 'qr.ts'));

// Decodes the rendered GIF data URL back to text via sharp (GIF -> RGBA
// pixels) and the library's own Decoder — reused from tests/qr.test.mjs so
// the small-payload round-trip assertion in this file is self-contained.
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

// ~3 KB ASCII payload in the offer-link shape: measured to throw
// `data overflow: 24048 > 18672` with the installed @nuintun/qrcode before
// the fix.
const oversizedPayload = 's=' + 'A'.repeat(3000);

test('buildQrDataUrl does not throw on an oversized payload (regression: data overflow)', () => {
  let url;
  assert.doesNotThrow(() => {
    url = buildQrDataUrl(oversizedPayload);
  }, 'a payload beyond M-level capacity must degrade, not throw during render');
  assert.equal(typeof url, 'string');
});

test('buildQrDataUrl returns a data URL placeholder for the oversized payload', () => {
  const url = buildQrDataUrl(oversizedPayload);
  assert.match(url, /^data:image\/svg\+xml;/, 'overflow must yield the SVG placeholder data URL');
  assert.doesNotMatch(
    url,
    /^data:image\/gif;/,
    'an unencodable payload must not claim to be a QR GIF'
  );
});

test('buildQrDataUrl is deterministic on the oversized payload (same input -> same placeholder)', () => {
  const a = buildQrDataUrl(oversizedPayload);
  const b = buildQrDataUrl('s=' + 'B'.repeat(4000)); // different oversized payload
  const c = buildQrDataUrl(oversizedPayload);
  assert.equal(a, c, 'identical oversized input must yield the identical placeholder');
  assert.equal(a, b, 'all oversized inputs degrade to the same constant placeholder');
});

test('buildQrDataUrl does not throw on a non-ASCII oversized payload', () => {
  // é is 2 UTF-8 bytes; the byte-encoding path must hit the same overflow
  // guard instead of escaping the try/catch.
  const payload = 's=' + 'é'.repeat(3000);
  assert.doesNotThrow(() => buildQrDataUrl(payload));
  assert.match(buildQrDataUrl(payload), /^data:image\/svg\+xml;/);
});

test('buildQrDataUrl still encodes a payload that fits M-level capacity (no false fallback)', () => {
  // ~2 KB ASCII measured to encode fine at the installed encoder version;
  // this pins the fallback to the real overflow boundary instead of firing
  // on payloads the encoder can actually hold.
  const payload = 's=' + 'A'.repeat(2000);
  const url = buildQrDataUrl(payload);
  assert.match(
    url,
    /^data:image\/gif;base64,/,
    'a fitting payload must still encode to a real QR GIF'
  );
});

test('buildQrDataUrl round-trips a normal payload (no behavior regression for small inputs)', async () => {
  const payload = 'https://zero-share.example/offer?sig=first-offer';
  const decoded = await decodeQrDataUrl(buildQrDataUrl(payload));
  assert.equal(decoded, payload, 'small payloads must still decode byte-for-byte');
});

test('QrModal still derives its image via buildQrDataUrl (no caller-side change needed)', async () => {
  // The fix lives in buildQrDataUrl itself; QrModal's $derived must keep
  // calling it directly so the overflow guard covers every mount site
  // (OfferPage offer QR and ReceivePage answer QR).
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    join(here, '..', 'src', 'components', 'qr', 'QrModal.svelte'),
    'utf8'
  );
  assert.match(
    source,
    /const qrcodeDataUrl = \$derived\(buildQrDataUrl\(qrData\)\);/,
    'QrModal must keep deriving the QR from buildQrDataUrl'
  );
});
