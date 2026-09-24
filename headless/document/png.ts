/**
 * PNG helpers for embedding textures without an image library.
 *
 * Blockbench stores embedded textures as data URLs plus their pixel size, so a
 * headless editor only needs the size from the PNG header (the IHDR chunk).
 *
 * @module
 */

export { type IPngSize, pngSize } from "@/lib/png";

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
