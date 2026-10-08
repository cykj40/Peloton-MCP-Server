import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(data: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xFF]! ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Losslessly recompress resvg's PNG IDAT stream; preserve scanline filters and all other chunks. */
export function compactPng(png: Buffer): Buffer {
  const chunks: Array<{ type: string; bytes: Buffer; data: Buffer }> = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + length + 12;
    chunks.push({ type: png.toString('ascii', offset + 4, offset + 8), bytes: png.subarray(offset, end), data: png.subarray(offset + 8, end - 4) });
    offset = end;
  }
  const idat = Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data));
  const compressed = deflateSync(inflateSync(idat), { level: 9 });
  const replacement = Buffer.alloc(compressed.length + 12);
  replacement.writeUInt32BE(compressed.length, 0);
  replacement.write('IDAT', 4, 'ascii');
  compressed.copy(replacement, 8);
  replacement.writeUInt32BE(crc32(replacement.subarray(4, -4)), replacement.length - 4);
  let inserted = false;
  const output = Buffer.concat([png.subarray(0, 8), ...chunks.flatMap(chunk => {
    if (chunk.type !== 'IDAT') return [chunk.bytes];
    if (inserted) return [];
    inserted = true;
    return [replacement];
  })]);
  return output.length < png.length ? output : png;
}
