import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
