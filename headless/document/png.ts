/**
 * PNG helpers for embedding textures without an image library.
 *
 * Blockbench stores embedded textures as data URLs plus their pixel size, so a
 * headless editor only needs the size from the PNG header (the IHDR chunk).
 *
 * @module
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Pixel size read from a PNG header. */
export interface IPngSize {
  width: number;
  height: number;
}

/**
 * Reads width and height from PNG bytes.
 *
 * @throws Error when the bytes are not a PNG.
 */
export function pngSize(bytes: Uint8Array): IPngSize {
  const isPng = bytes.length >= 24 && PNG_SIGNATURE.every((value, i) => bytes[i] === value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hasHeader = isPng && String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR";
  if (!hasHeader) throw new Error("The image is not a PNG file.");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Encodes PNG bytes as a data URL. */
export function pngDataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * Decodes a PNG data URL.
 *
 * @throws Error when the URL is not a base64 PNG data URL.
 */
export function decodePngDataUrl(url: string): Uint8Array {
  const match = /^data:image\/png;base64,(.+)$/s.exec(url);
  if (!match?.[1]) throw new Error("Expected a base64 PNG data URL (data:image/png;base64,...).");
  return new Uint8Array(Buffer.from(match[1], "base64"));
}
