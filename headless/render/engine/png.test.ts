import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

import { decodePng, encodePng, flipRows } from "./png";

/** Builds a PNG from raw scanlines so decode paths beyond RGBA8 can be exercised. */
function rawPng(width: number, height: number, depth: number, colorType: number, scanlines: number[][], extra: { type: string; data: number[] }[] = [], filters: number[] = []): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => Array.from({ length: 8 }).reduce<number>((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n));
  const crc = (bytes: Buffer): number => (bytes.reduce((c, b) => crcTable[(c ^ b) & 0xff]! ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([depth, colorType, 0, 0, 0], 8);
  const raw = Buffer.from(scanlines.flatMap((row, y) => [filters[y] ?? 0, ...row]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...extra.map((entry) => chunk(entry.type, Buffer.from(entry.data))),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("png codec", () => {
  test("round-trips RGBA pixels", () => {
    const pixels = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40]);
    const decoded = decodePng(encodePng(pixels, 2, 2));
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect([...decoded.data]).toEqual([...pixels]);
  });

  test("round-trips an image large enough to use every filter path", () => {
    const width = 37;
    const height = 29;
    const pixels = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 7 + Math.floor(i / 13)) & 0xff);
    expect([...decodePng(encodePng(pixels, width, height)).data]).toEqual([...pixels]);
  });

  test("applies sub, up, average and paeth filters", () => {
    // 2x1 RGB pixels (10,20,30) (40,50,60) stored with sub, then as a second row with up/average/paeth.
    const sub = decodePng(rawPng(2, 1, 8, 2, [[10, 20, 30, 30, 30, 30]], [], [1]));
    expect([...sub.data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    const rows = [[10, 20, 30, 40, 50, 60], [1, 1, 1, 1, 1, 1]];
    expect([...decodePng(rawPng(2, 2, 8, 2, rows, [], [0, 2])).data.subarray(8)]).toEqual([11, 21, 31, 255, 41, 51, 61, 255]);
    // average: (left + up) >> 1; first pixel has left 0 and up 10/20/30.
    expect([...decodePng(rawPng(2, 2, 8, 2, [[10, 20, 30, 40, 50, 60], [0, 0, 0, 0, 0, 0]], [], [0, 3])).data.subarray(8, 12)]).toEqual([5, 10, 15, 255]);
    // paeth with no left pixel predicts from up.
    expect([...decodePng(rawPng(2, 2, 8, 2, [[10, 20, 30, 40, 50, 60], [1, 1, 1, 1, 1, 1]], [], [0, 4])).data.subarray(8, 12)]).toEqual([11, 21, 31, 255]);
  });

  test("decodes 8-bit RGB as opaque RGBA", () => {
    expect([...decodePng(rawPng(1, 1, 8, 2, [[1, 2, 3]])).data]).toEqual([1, 2, 3, 255]);
  });

  test("expands palette images with tRNS alpha", () => {
    const png = rawPng(2, 1, 8, 3, [[0, 1]], [
      { type: "PLTE", data: [255, 0, 0, 0, 0, 255] },
      { type: "tRNS", data: [255, 64] },
    ]);
    expect([...decodePng(png).data]).toEqual([255, 0, 0, 255, 0, 0, 255, 64]);
  });

  test("scales sub-byte grayscale and reads gray+alpha", () => {
    expect([...decodePng(rawPng(4, 1, 2, 0, [[0b00011011]])).data]).toEqual([0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255]);
    expect([...decodePng(rawPng(1, 1, 8, 4, [[100, 50]])).data]).toEqual([100, 100, 100, 50]);
  });

  test("rejects non-PNG data and interlaced images", () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3]))).toThrow("not a PNG");
    const interlaced = Buffer.from(rawPng(1, 1, 8, 6, [[1, 2, 3, 4]]));
    interlaced[8 + 8 + 12] = 1;
    expect(() => decodePng(interlaced)).toThrow();
  });

  test("flipRows puts the bottom row first", () => {
    const flipped = flipRows({ width: 1, height: 2, data: Uint8Array.from([1, 1, 1, 1, 2, 2, 2, 2]) });
    expect([...flipped]).toEqual([2, 2, 2, 2, 1, 1, 1, 1]);
  });
});
