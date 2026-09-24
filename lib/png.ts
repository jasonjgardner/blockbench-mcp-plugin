/**
 * PNG header parsing without an image library, shared by the desktop plugin
 * and the headless server (which may import `lib/`, never the reverse).
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
 * Reads width and height from PNG bytes (the IHDR chunk).
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
