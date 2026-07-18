// Minimal zip writer for TESTS (store for directories, deflate for files):
// a spec-conformant archive — deflate via node:zlib, CRC32 by table — so
// walkers exercise real decompression without committing binary fixtures.
// Shared by worker/takeout.test.ts and worker/apple-health/apple-health.test.ts;
// not part of the worker runtime.

import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  name: string;
  /** Uncompressed content; empty for directories. */
  data: Buffer;
  directory?: boolean;
  /**
   * Replaces the deflated payload verbatim (with a bogus CRC) to model a
   * zip member whose compressed stream is corrupt.
   */
  rawCompressed?: Buffer;
}

export function buildZip(entries: ZipEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const path =
      entry.directory && !entry.name.endsWith("/")
        ? `${entry.name}/`
        : entry.name;
    const nameBytes = Buffer.from(path, "utf8");
    const method = entry.directory ? 0 : 8;
    const compressed = entry.directory
      ? Buffer.alloc(0)
      : (entry.rawCompressed ?? deflateRawSync(entry.data));
    const crc = entry.rawCompressed ? 0 : crc32(entry.data);
    const size = entry.directory ? 0 : entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, compressed);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); // central directory header
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42); // local header offset
    central.push(record, nameBytes);

    offset += 30 + nameBytes.length + compressed.length;
  }

  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBytes, eocd]);
}
