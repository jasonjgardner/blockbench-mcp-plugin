/**
 * Minimal PNG codec on `node:zlib`, replacing sharp for the two jobs the renderer has: decoding
 * a model's texture to RGBA and encoding a rendered frame.
 *
 * Decoding covers what Blockbench writes: non-interlaced grayscale, gray+alpha, RGB, RGBA and
 * palette images at 1-16 bits, with `tRNS` transparency. 16-bit samples are reduced to 8.
 */
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decoded pixels: tightly packed RGBA8, top row first. */
export interface IRgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Samples per pixel for each PNG color type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) =>
  Array.from({ length: 8 }).reduce<number>((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n),
);

const crc32 = (bytes: Uint8Array): number =>
  (bytes.reduce((crc, byte) => CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/** Reverses PNG scanline filtering and returns the raw scanlines without their filter bytes. */
function unfilter(raw: Uint8Array, height: number, bytesPerPixel: number, rowBytes: number): Uint8Array {
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)] ?? 0;
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= bytesPerPixel ? out[dst + x - bytesPerPixel]! : 0;
      const up = y > 0 ? out[dst - rowBytes + x]! : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? out[dst - rowBytes + x - bytesPerPixel]! : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      if (predictor === undefined) throw new Error(`PNG has an invalid filter type ${filter}`);
      out[dst + x] = (raw[src + x]! + predictor) & 0xff;
    }
  }
  return out;
}

/** Reads sample `index` of a scanline; 16-bit keeps its high byte and sub-byte depths scale to 0-255 unless `raw`. */
function sample(row: Uint8Array, index: number, depth: number, raw: boolean): number {
  if (depth === 8) return row[index]!;
  if (depth === 16) return row[index * 2]!;
  const perByte = 8 / depth;
  const shift = 8 - depth * ((index % perByte) + 1);
  const value = (row[Math.floor(index / perByte)]! >> shift) & ((1 << depth) - 1);
  return raw ? value : Math.round((value * 255) / ((1 << depth) - 1));
}

/**
 * Decodes a PNG to RGBA8.
 *
 * @throws Error for non-PNG data, interlaced images and truncated files.
 */
export function decodePng(bytes: Uint8Array): IRgbaImage {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("Texture is not a PNG (only PNG textures can be rendered)");

  const chunks: { type: string; data: Buffer }[] = [];
  for (let offset = 8; offset + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    if (offset + 12 + length > buffer.length) throw new Error("PNG is truncated");
    chunks.push({ type: buffer.toString("latin1", offset + 4, offset + 8), data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  const header = chunks.find((entry) => entry.type === "IHDR")?.data;
  if (header === undefined || header.length < 13) throw new Error("PNG has no IHDR chunk");
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8]!;
  const colorType = header[9]!;
  if (header[12] !== 0) throw new Error("Interlaced PNG textures are not supported; re-save the texture without interlacing");
  const channels = CHANNELS[colorType];
  if (channels === undefined || ![1, 2, 4, 8, 16].includes(depth)) throw new Error(`Unsupported PNG format (color type ${colorType}, ${depth}-bit)`);

  const raw = inflateSync(Buffer.concat(chunks.filter((entry) => entry.type === "IDAT").map((entry) => entry.data)));
  const bitsPerPixel = channels * depth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < (rowBytes + 1) * height) throw new Error("PNG pixel data is truncated");
  const pixels = unfilter(raw, height, Math.max(1, bitsPerPixel >> 3), rowBytes);

  const palette = chunks.find((entry) => entry.type === "PLTE")?.data;
  const trns = chunks.find((entry) => entry.type === "tRNS")?.data;
  if (colorType === 3 && palette === undefined) throw new Error("Palette PNG has no PLTE chunk");
  const out = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const at = (channel: number): number => sample(row, x * channels + channel, depth, false);
      if (colorType === 3) {
        const index = sample(row, x, depth, true);
        out.set([palette![index * 3] ?? 0, palette![index * 3 + 1] ?? 0, palette![index * 3 + 2] ?? 0, trns?.[index] ?? 255], o);
      } else if (colorType === 0) {
        const keyed = trns !== undefined && trns.length >= 2 && depth <= 8 && sample(row, x, depth, true) === trns.readUInt16BE(0);
        out.set([at(0), at(0), at(0), keyed ? 0 : 255], o);
      } else if (colorType === 4) {
        out.set([at(0), at(0), at(0), at(1)], o);
      } else if (colorType === 2) {
        const keyed = trns !== undefined && trns.length >= 6 && depth === 8 && row[x * 3] === trns[1] && row[x * 3 + 1] === trns[3] && row[x * 3 + 2] === trns[5];
        out.set([at(0), at(1), at(2), keyed ? 0 : 255], o);
      } else {
        out.set([at(0), at(1), at(2), at(3)], o);
      }
    }
  }
  return { width, height, data: out };
}

/** Builds one PNG chunk with its length and CRC. */
function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Encodes tightly packed RGBA8 pixels (top row first) as an 8-bit RGBA PNG. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  if (rgba.length !== width * height * 4) throw new Error(`Expected ${width * height * 4} RGBA bytes for ${width}x${height}, got ${rgba.length}`);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))]);
}

/** Flips an RGBA image vertically into a new array. */
export function flipRows(image: IRgbaImage): Uint8Array {
  const rowBytes = image.width * 4;
  const out = new Uint8Array(image.data.length);
  for (let y = 0; y < image.height; y++) out.set(image.data.subarray(y * rowBytes, (y + 1) * rowBytes), (image.height - 1 - y) * rowBytes);
  return out;
}
