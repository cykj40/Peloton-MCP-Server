import { inflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { compactPng } from '../charts/compactPng.js';

function chunks(png: Buffer): Array<{ type: string; data: Buffer; bytes: Buffer }> {
  const parts = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), end = offset + length + 12;
    parts.push({ type: png.toString('ascii', offset + 4, offset + 8), data: png.subarray(offset + 8, end - 4), bytes: png.subarray(offset, end) });
    offset = end;
  }
  return parts;
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><defs><linearGradient id="g"><stop stop-color="#FCFFA4"/><stop offset="1" stop-color="#781C6C"/></linearGradient></defs><rect width="160" height="160" fill="url(#g)"/><circle cx="80" cy="80" r="50" fill="#5CC8FF"/></svg>';
const options = { font: { loadSystemFonts: false } };

describe('lossless PNG compression', () => {
  it('keeps scanline bytes, dimensions and non-IDAT chunks identical and never increases size', () => {
    const original = Buffer.from(new Resvg(svg, options).render().asPng()), compact = compactPng(original);
    const a = chunks(original), b = chunks(compact);
    const data = (parts: ReturnType<typeof chunks>) => inflateSync(Buffer.concat(parts.filter(part => part.type === 'IDAT').map(part => part.data)));
    expect(data(a).equals(data(b))).toBe(true);
    expect(a.filter(part => part.type !== 'IDAT').map(part => part.bytes)).toEqual(b.filter(part => part.type !== 'IDAT').map(part => part.bytes));
    expect(compact.length).toBeLessThanOrEqual(original.length);
  });
  it('decodes through resvg with valid CRCs and exactly the original RGBA pixels', () => {
    const original = new Resvg(svg, options).render();
    const png = compactPng(Buffer.from(original.asPng()));
    const decoded = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><image width="160" height="160" href="data:image/png;base64,${png.toString('base64')}"/></svg>`, options).render();
    expect(decoded.pixels.equals(original.pixels)).toBe(true);
  });
});
