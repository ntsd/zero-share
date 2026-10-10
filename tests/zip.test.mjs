import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Regression test for the store-only ZIP writer (src/utils/zip.ts) used by the
// receive page "Download all files (zip)" button. Node strips the type
// annotations in zip.ts natively (erasable TS syntax).
const here = dirname(fileURLToPath(import.meta.url));
const { createZipStoreOnly, crc32 } = await import(join(here, '..', 'src', 'utils', 'zip.ts'));

const dir = await mkdtemp(join(tmpdir(), 'zip-test-'));
try {
  // --- crc32 self-check against known vectors ---
  assert.equal(crc32(new Uint8Array(0)), 0, 'crc32(empty) must be 0');
  assert.equal(
    crc32(new TextEncoder().encode('12345')).toString(16),
    'cbf53a1c',
    'crc32("12345") must be 0xCBF53A1C'
  );
  assert.equal(
    crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')).toString(16),
    '414fa339',
    'crc32(fox sentence) must be 0x414FA339'
  );

  // --- round trip: 3 files, one of which is a Blob (as the receiver stores it) ---
  const a = new TextEncoder().encode('hello zero-share');
  const b = new Uint8Array(4096).map((_, i) => i & 0xff);
  const cText = 'café ünïcödé 名前';
  const files = [
    { name: 'a.txt', data: a },
    { name: 'b.bin', data: b },
    { name: 'c.txt', data: new Blob([new TextEncoder().encode(cText)]) }
  ];
  const zip = await createZipStoreOnly(files);

  const zipPath = join(dir, 'out.zip');
  await writeFile(zipPath, zip);

  // Preferred validator: `unzip` (real reference implementation).
  const { spawnSync } = await import('node:child_process');
  const which = spawnSync('sh', ['-c', 'command -v unzip']);
  if (which.status === 0) {
    const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
    for (const n of ['a.txt', 'b.bin', 'c.txt']) {
      assert.ok(listing.includes(n), `unzip -l must list ${n}\n${listing}`);
    }
    const extracted = execFileSync('unzip', ['-o', '-q', zipPath, '-d', dir + '/ext'], {
      encoding: 'utf8'
    });
    assert.ok(
      extracted.includes('No errors detected') || extracted.length === 0,
      `unzip must extract cleanly:\n${extracted}`
    );
    const { readFile } = await import('node:fs/promises');
    assert.ok(
      Buffer.compare(await readFile(join(dir, 'ext', 'a.txt')), Buffer.from(a)) === 0,
      'extracted a.txt must match input'
    );
    assert.ok(
      Buffer.compare(await readFile(join(dir, 'ext', 'b.bin')), Buffer.from(b)) === 0,
      'extracted b.bin must match input'
    );
    assert.equal(
      (await readFile(join(dir, 'ext', 'c.txt'))).toString('utf8'),
      cText,
      'extracted c.txt must match input (UTF-8 name + content)'
    );
  } else {
    // Fallback: minimal structural parse so the suite still guards the writer.
    const dv = new DataView(zip.buffer);
    // Locate the End Of Central Directory record.
    let eocd = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    assert.ok(eocd >= 0, 'EOCD signature found');
    assert.equal(dv.getUint16(eocd + 10, true), 3, 'EOCD total entries = 3');
    assert.equal(dv.getUint16(eocd + 12, true), 3, 'EOCD entries on this disk = 3');

    // Expected contents keyed by name.
    const expected = {
      'a.txt': a,
      'b.bin': b,
      'c.txt': new TextEncoder().encode(cText)
    };

    // Walk the central directory, then verify each entry's stored data.
    let off = dv.getUint32(eocd + 16, true); // central directory start
    let seen = 0;
    for (let i = 0; i < 3; i++) {
      assert.equal(dv.getUint32(off, true), 0x02014b50, 'central dir signature');
      const nameLen = dv.getUint16(off + 28, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = new TextDecoder().decode(zip.subarray(off + 46, off + 46 + nameLen));
      assert.ok(name in expected, `unexpected entry in central dir: ${name}`);

      // Walk the matching local header and compare the stored bytes.
      assert.equal(dv.getUint32(localOff, true), 0x04034b50, 'local header signature');
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lName = new TextDecoder().decode(zip.subarray(localOff + 30, localOff + 30 + lNameLen));
      assert.equal(lName, name, 'central and local names agree');
      const size = dv.getUint32(localOff + 18, true);
      const dataStart = localOff + 30 + lNameLen;
      assert.deepEqual(
        zip.subarray(dataStart, dataStart + size),
        expected[name],
        `stored bytes for ${name} must match input`
      );
      seen++;
      off += 46 + nameLen;
    }
    assert.equal(seen, 3, 'all 3 entries walked');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('ok - store-only ZIP writer round-trip (crc32 + valid archive)');
