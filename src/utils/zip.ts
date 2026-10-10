// Store-only ZIP writer: assembles an uncompressed (method 0) archive from
// in-memory buffers so the receive page can offer a real single-file
// "download all (zip)" without any new dependency.

export interface ZipEntry {
  name: string;
  data: Uint8Array<ArrayBuffer> | Blob;
}

// Precomputed CRC32 lookup table (IEEE 802.3 polynomial, reversed).
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[i] = c >>> 0;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Collapse empty/./.. names and duplicate names so the archive stays valid.
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const base = raw.replace(/^[./]+/, '') || 'file';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base} (${n})`;
  });
}

// Builds an uncompressed ZIP (local headers + file data + central directory +
// EOCD). File names are UTF-8 with the 0x800 flag set; fixed valid DOS time.
export async function createZipStoreOnly(files: ZipEntry[]): Promise<Uint8Array<ArrayBuffer>> {
  if (files.length === 0) {
    throw new Error('createZipStoreOnly: no files to archive');
  }

  const entries = await Promise.all(
    files.map(async (f) => {
      const data = f.data instanceof Blob ? new Uint8Array(await f.data.arrayBuffer()) : f.data;
      return { name: f.name, data, crc: crc32(data) };
    })
  );
  const names = uniqueNames(entries.map((e) => e.name));
  const nameBytes = names.map((n) => new TextEncoder().encode(n));

  const localOffset: number[] = [];
  let o = 0;
  entries.forEach((e, i) => {
    localOffset[i] = o;
    o += 30 + nameBytes[i].length + e.data.length;
  });
  const centralStart = o;
  const centralSize = entries.reduce((sum, e, i) => sum + 46 + nameBytes[i].length, 0);
  const total = centralStart + centralSize + 22;

  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const bytes = new Uint8Array(out);

  // Local file headers + raw file data
  entries.forEach((e, i) => {
    const off = localOffset[i];
    dv.setUint32(off + 0, 0x04034b50, true); // local file header signature
    dv.setUint16(off + 4, 20, true); // version needed
    dv.setUint16(off + 6, 0x0800, true); // UTF-8 file name
    dv.setUint16(off + 8, 0, true); // method: stored
    dv.setUint16(off + 10, 0x0021, true); // DOS time
    dv.setUint16(off + 12, 0x5821, true); // DOS date (2024-01-01)
    dv.setUint32(off + 14, e.crc, true);
    dv.setUint32(off + 18, e.data.length, true); // compressed size
    dv.setUint32(off + 22, e.data.length, true); // uncompressed size
    dv.setUint16(off + 26, nameBytes[i].length, true);
    dv.setUint16(off + 28, 0, true); // extra field length
    bytes.set(nameBytes[i], off + 30);
    bytes.set(e.data, off + 30 + nameBytes[i].length);
  });

  // Central directory
  let offset = centralStart;
  entries.forEach((e, i) => {
    dv.setUint32(offset + 0, 0x02014b50, true); // central directory signature
    dv.setUint16(offset + 4, 20, true); // version made by
    dv.setUint16(offset + 6, 20, true); // version needed
    dv.setUint16(offset + 8, 0x0800, true); // general purpose flags: UTF-8
    dv.setUint16(offset + 10, 0, true); // compression method: stored
    dv.setUint16(offset + 12, 0x0021, true); // mod time
    dv.setUint16(offset + 14, 0x5821, true); // mod date
    dv.setUint32(offset + 16, e.crc, true); // crc-32
    dv.setUint32(offset + 20, e.data.length, true); // compressed size
    dv.setUint32(offset + 24, e.data.length, true); // uncompressed size
    dv.setUint16(offset + 28, nameBytes[i].length, true); // file name length
    dv.setUint16(offset + 30, 0, true); // extra field length
    dv.setUint16(offset + 32, 0, true); // file comment length
    dv.setUint16(offset + 34, 0, true); // disk number start
    dv.setUint16(offset + 36, 0, true); // internal file attributes
    dv.setUint32(offset + 38, 0, true); // external file attributes
    dv.setUint32(offset + 42, localOffset[i], true); // relative offset of local header
    bytes.set(nameBytes[i], offset + 46);
    offset += 46 + nameBytes[i].length;
  });

  // End of central directory record
  dv.setUint32(total - 22, 0x06054b50, true);
  dv.setUint16(total - 18, 0, true); // disk number
  dv.setUint16(total - 16, 0, true); // disk with central directory
  dv.setUint16(total - 14, entries.length, true);
  dv.setUint16(total - 12, entries.length, true);
  dv.setUint32(total - 10, centralSize, true);
  dv.setUint32(total - 6, centralStart, true);
  dv.setUint16(total - 2, 0, true); // comment length

  return bytes;
}
