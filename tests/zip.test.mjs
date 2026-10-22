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
const { createZipStoreOnly, crc32, sanitizeName } = await import(
  join(here, '..', 'src', 'utils', 'zip.ts')
);

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

  // --- round trip: duplicate + pre-suffixed names must stay collision-free ---
  // uniqueNames must never emit a name that already exists in the output:
  // OS download folders routinely yield "photo.jpg" + "photo.jpg (1)", so the
  // realistic trigger is an ordinary peer-controlled name list like the one
  // below (unzip -o / Explorer / Archive Utility would otherwise silently
  // drop one file on extract).
  const r1 = new TextEncoder().encode('original report v1');
  const r2 = new TextEncoder().encode('second copy report v2');
  const r1s = new TextEncoder().encode('pre-suffixed report');
  const x1 = new TextEncoder().encode('x one');
  const x2 = new TextEncoder().encode('x two');
  const x1s = new TextEncoder().encode('x presuffix');
  const dupFiles = [
    { name: 'report.pdf', data: r1 },
    { name: 'report.pdf', data: r2 },
    { name: 'report.pdf (1)', data: r1s },
    { name: 'x', data: x1 },
    { name: 'x', data: x2 },
    { name: 'x (1)', data: x1s }
  ];
  const dupZip = await createZipStoreOnly(dupFiles);
  const dupZipPath = join(dir, 'dup.zip');
  await writeFile(dupZipPath, dupZip);

  // Walk the central directory: return its entry names and local-header
  // offsets, and assert the EOCD entry count equals the input file count.
  const cdWalk = (buf) => {
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    assert.ok(eocd >= 0, 'dup.zip: EOCD signature found');
    const count = dv.getUint16(eocd + 10, true); // total entries on all disks
    assert.equal(count, dupFiles.length, 'EOCD total entries must equal input file count');
    assert.equal(dv.getUint16(eocd + 8, true), count, 'EOCD entries on this disk must match');
    const entries = [];
    let off = dv.getUint32(eocd + 16, true);
    for (let i = 0; i < count; i++) {
      assert.equal(dv.getUint32(off, true), 0x02014b50, 'dup.zip: central dir signature');
      const nameLen = dv.getUint16(off + 28, true);
      const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
      entries.push({ name, localOff: dv.getUint32(off + 42, true), nameLen });
      off += 46 + nameLen;
    }
    return entries;
  };
  const entries = cdWalk(dupZip);
  const names = entries.map((e) => e.name);
  assert.equal(
    new Set(names).size,
    names.length,
    `central directory names must be unique, got: ${JSON.stringify(names)}`
  );

  // First occurrences keep their names verbatim; the 2nd duplicate and the
  // pre-suffixed name are disambiguated by bumping past already-used names.
  const dupExpected = {
    'report.pdf': r1,
    'report.pdf (1)': r2,
    'report.pdf (1) (1)': r1s,
    x: x1,
    'x (1)': x2,
    'x (1) (1)': x1s
  };
  assert.deepEqual(
    [...names].sort(),
    Object.keys(dupExpected).sort(),
    'dup.zip must contain exactly the expected deduplicated entry names'
  );

  if (spawnSync('sh', ['-c', 'command -v unzip']).status === 0) {
    execFileSync('unzip', ['-o', '-q', dupZipPath, '-d', dir + '/ext-dup'], {
      encoding: 'utf8'
    });
    const { readFile: rd } = await import('node:fs/promises');
    for (const [n, want] of Object.entries(dupExpected)) {
      assert.ok(
        Buffer.compare(await rd(join(dir, 'ext-dup', n)), Buffer.from(want)) === 0,
        `extracted ${n} must match its distinct input content`
      );
    }
  } else {
    // Fallback: verify each entry's stored bytes via its local header.
    const dv = new DataView(dupZip.buffer);
    for (const { name, localOff, nameLen } of entries) {
      assert.equal(dv.getUint32(localOff, true), 0x04034b50, 'dup.zip: local header signature');
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lName = new TextDecoder().decode(
        dupZip.subarray(localOff + 30, localOff + 30 + lNameLen)
      );
      assert.equal(lName, name, 'dup.zip: central and local names agree');
      const size = dv.getUint32(localOff + 18, true);
      const dataStart = localOff + 30 + lNameLen;
      assert.deepEqual(
        dupZip.subarray(dataStart, dataStart + size),
        dupExpected[name],
        `stored bytes for ${name} must match its distinct input content`
      );
    }
  }

  // --- classic-ZIP 4 GiB guard: 32-bit fields wrap, so the writer must refuse ---
  // Demonstrate the silent-corruption mechanism the guard exists for:
  // DataView.setUint32 truncates its argument to 32 bits, so a 4 GiB + 1 size
  // lands at 1 (and exactly 4 GiB at 0) in the header — not even the
  // 0xFFFFFFFF "see zip64 extra" sentinel.
  const wrap = new DataView(new ArrayBuffer(4));
  wrap.setUint32(0, 0x100000000, true);
  assert.equal(wrap.getUint32(0, true), 0, 'setUint32 wraps 0x100000000 to 0');
  wrap.setUint32(0, 0x100000001, true);
  assert.equal(wrap.getUint32(0, true), 1, 'setUint32 wraps 0x100000001 to 1');

  // Allocating a > 4 GiB buffer in-test is impractical, so pin the guard
  // statically: entry-size and total/offset bounds checks must both throw
  // before `new ArrayBuffer(total)` allocates the (now provably in-range) buffer.
  const { readFile: readSrc } = await import('node:fs/promises');
  const zipSrc = await readSrc(join(here, '..', 'src', 'utils', 'zip.ts'), 'utf8');
  const entryGuardRe =
    /entries\[i\]\.data\.length\s*>=\s*MAX_CLASSIC_SIZE[\s\S]{0,200}?throw\s+new\s+Error\(/;
  assert.ok(
    entryGuardRe.test(zipSrc),
    'zip.ts must throw a descriptive error when an entry exceeds the 4 GiB classic-ZIP limit'
  );
  const allocIdx = zipSrc.indexOf('new ArrayBuffer(total)');
  assert.ok(allocIdx > 0, 'zip.ts must allocate via new ArrayBuffer(total)');
  assert.ok(
    zipSrc.slice(0, allocIdx).includes('centralStart > MAX_CLASSIC_SIZE') &&
      zipSrc.slice(0, allocIdx).includes('total > MAX_CLASSIC_SIZE'),
    'total/centralStart bounds check must precede the ArrayBuffer allocation'
  );
  assert.ok(
    /const\s+MAX_CLASSIC_SIZE\s*=\s*0xffffffff/.test(zipSrc),
    'guard constant must be the 32-bit unsigned max (0xffffffff)'
  );

  console.log('ok - 4 GiB classic-ZIP guard (wrap semantics + source guards)');

  // --- zip-slip guard: peer-controlled names with embedded traversal ---
  // MetaData.name is peer-controlled and was written byte-for-byte into the
  // local header + central directory; a name like "a/b/../../../../etc/passwd"
  // extracts OUTSIDE the archive folder on unzip (CWE-22). sanitizeName() must
  // reduce every name to a safe basename, and the emitted archive must carry
  // no "/", "\", or ".." in ANY entry name.
  const unsafe = ['a/b/../../../../etc/passwd', 'sub/../../x.png', 'C:\\\\evil\\\\evil.txt'];
  for (const n of unsafe) {
    assert.ok(
      !sanitizeName(n).includes('/'),
      `sanitizeName(${JSON.stringify(n)}) must contain no '/'`
    );
    assert.ok(
      !sanitizeName(n).includes('\\'),
      `sanitizeName(${JSON.stringify(n)}) must contain no backslash`
    );
    assert.ok(
      !sanitizeName(n).includes('..'),
      `sanitizeName(${JSON.stringify(n)}) must contain no '..'`
    );
  }
  assert.equal(
    sanitizeName('a/b/../../../../etc/passwd'),
    'passwd',
    'POSIX traversal: basename survives, traversal removed'
  );
  assert.equal(
    sanitizeName('sub/../../x.png'),
    'x.png',
    'relative traversal up: basename survives'
  );
  assert.equal(sanitizeName('..'), 'file', 'pure dot-dot must fall back to the safe default');
  assert.equal(sanitizeName('...'), 'file', 'trailing-dots run must fall back to the safe default');
  assert.equal(sanitizeName(''), 'file', 'empty name must fall back to the safe default');
  assert.equal(
    sanitizeName('..\\..\\win.txt'),
    'win.txt',
    'Windows backslash traversal: basename survives'
  );
  assert.equal(
    sanitizeName('a\u2215b\u2215c'),
    'c',
    'U+2215 division slash is a path separator too'
  );
  assert.equal(
    sanitizeName('a\u0000b.txt'),
    'ab.txt',
    'NUL/control chars are stripped, name stays a single safe token'
  );
  assert.equal(
    sanitizeName('report.pdf'),
    'report.pdf',
    'a safe ordinary name must pass through unchanged'
  );
  assert.equal(
    sanitizeName('tar.gz..'),
    'tar.gz.',
    'a legitimate trailing dot (e.g. "archive.") is preserved, dot runs collapse'
  );
  // Idempotent: a second pass must be a no-op (the receiver sanitizes at
  // ingestion AND the zip writer re-sanitizes — the second pass must not
  // mutate the first pass's output).
  for (const n of [...unsafe, 'report.pdf', 'tar.gz..']) {
    assert.equal(
      sanitizeName(sanitizeName(n)),
      sanitizeName(n),
      `sanitizeName(${JSON.stringify(n)}) must be idempotent`
    );
  }

  // End-to-end: traversal names fed to the REAL writer must be neutralized in
  // every emitted entry name (central directory AND local headers) — no entry
  // may resolve to a path outside the archive root, and dedup must still run
  // on the sanitized names ("passwd" twice -> "passwd", "passwd (1)").
  const w1 = new TextEncoder().encode('w one');
  const w2 = new TextEncoder().encode('w two');
  const w3 = new TextEncoder().encode('w three');
  const traversalFiles = [
    { name: 'a/b/../../../../etc/passwd', data: w1 },
    { name: '../../../../passwd', data: w2 }, // duplicates the sanitized "passwd"
    { name: 'sub/../../x.png', data: w3 }
  ];
  const traversalZip = await createZipStoreOnly(traversalFiles);
  const tDV = new DataView(traversalZip.buffer);
  let tEocd = -1;
  for (let i = traversalZip.length - 22; i >= 0; i--) {
    if (tDV.getUint32(i, true) === 0x06054b50) {
      tEocd = i;
      break;
    }
  }
  assert.ok(tEocd >= 0, 'traversal.zip: EOCD signature found');
  assert.equal(
    tDV.getUint16(tEocd + 10, true),
    traversalFiles.length,
    'traversal.zip: EOCD total entries must equal the input file count'
  );
  const safeName = (n) =>
    !n.includes('/') && !n.includes('\\') && !n.includes('..') && !/[\u0000-\u001f\u007f]/.test(n);
  const tNames = [];
  let tOff = tDV.getUint32(tEocd + 16, true); // central directory start
  for (let i = 0; i < traversalFiles.length; i++) {
    assert.equal(tDV.getUint32(tOff, true), 0x02014b50, 'traversal.zip: central dir signature');
    const tNameLen = tDV.getUint16(tOff + 28, true);
    const tName = new TextDecoder().decode(traversalZip.subarray(tOff + 46, tOff + 46 + tNameLen));
    assert.ok(
      safeName(tName),
      `emitted entry name ${JSON.stringify(tName)} must contain no "/", "\\", "..", or control chars`
    );
    // The central-directory name must equal its local-header name.
    const tLocalOff = tDV.getUint32(tOff + 42, true);
    assert.equal(
      tDV.getUint32(tLocalOff, true),
      0x04034b50,
      'traversal.zip: local header signature'
    );
    const tLNameLen = tDV.getUint16(tLocalOff + 26, true);
    const tLName = new TextDecoder().decode(
      traversalZip.subarray(tLocalOff + 30, tLocalOff + 30 + tLNameLen)
    );
    assert.equal(tLName, tName, 'traversal.zip: central and local names agree');
    tNames.push(tName);
    tOff += 46 + tNameLen;
  }
  assert.equal(
    new Set(tNames).size,
    tNames.length,
    `traversal.zip central directory names must be unique, got: ${JSON.stringify(tNames)}`
  );
  assert.deepEqual(
    [...tNames].sort(),
    ['passwd', 'passwd (1)', 'x.png'],
    'traversal.zip must contain exactly the sanitized, deduplicated entry names'
  );
  if (spawnSync('sh', ['-c', 'command -v unzip']).status === 0) {
    // Real extractor proof: every file must land inside the extract dir.
    const tZipPath = join(dir, 'traversal.zip');
    await writeFile(tZipPath, traversalZip);
    execFileSync('unzip', ['-o', '-q', tZipPath, '-d', dir + '/ext-trav'], { encoding: 'utf8' });
    const { readdir } = await import('node:fs/promises');
    const extracted = await readdir(join(dir, 'ext-trav'));
    assert.deepEqual(
      extracted.sort(),
      ['passwd', 'passwd (1)', 'x.png'].sort(),
      `unzip must extract exactly the sanitized names into the archive root, got: ${JSON.stringify(extracted)}`
    );
  }
  console.log(
    'ok - peer-controlled names with path traversal are neutralized (zip-slip / CWE-22 guard)'
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('ok - store-only ZIP writer round-trip (crc32 + valid archive)');
