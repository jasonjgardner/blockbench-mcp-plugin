/**
 * Size and encoding of images that tools return. Captures are full-size PNGs
 * by default, which for a large viewport or the whole app window can take
 * megabytes of a client's context; callers can ask for a smaller or lossy copy.
 *
 * @module
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { imageFormatEnum } from "@/lib/zodObjects";

/** Encoding of a returned image. */
export type ImageFormat = z.infer<typeof imageFormatEnum>;

/** Output options accepted by tools that return images; see `imageOutputShape`. */
export interface IImageOutputOptions {
  /** Longest side in pixels; larger images are scaled down proportionally. */
  max_size?: number;
  /** Encoding; PNG when omitted. */
  format?: ImageFormat;
}

/** Pixel dimensions of an image. */
export interface IImageSize {
  width: number;
  height: number;
}

/**
 * Scales a size down (never up) so its longest side is at most `maxSize`,
 * keeping the aspect ratio.
 */
export function fitWithin(width: number, height: number, maxSize?: number): IImageSize {
  const longest = Math.max(width, height);
  if (maxSize === undefined || longest <= maxSize) return { width, height };
  const scale = maxSize / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
}

/**
 * Re-encodes a data URL image, scaled to `max_size` and in `format`. The input
 * is returned unchanged when it already has the requested encoding and size.
 *
 * @returns A data URL. A browser without an encoder for `format` falls back to
 *   PNG, and the URL says so.
 */
export async function encodeImage(dataUrl: string, options: IImageOutputOptions): Promise<string> {
  const mimeType = `image/${options.format ?? "png"}`;
  const sameEncoding = dataUrl.startsWith(`data:${mimeType};`);
  if (options.max_size === undefined && sameEncoding) return dataUrl;
  const image = await decodeImage(dataUrl);
  const { width, height } = fitWithin(image.naturalWidth, image.naturalHeight, options.max_size);
  if (sameEncoding && width === image.naturalWidth && height === image.naturalHeight) return dataUrl;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cannot re-encode the image: no 2D canvas is available.");
  // JPEG has no alpha channel: without a background, transparent pixels turn black.
  if (options.format === "jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL(mimeType);
}

/**
 * Applies {@link encodeImage} to every image of a tool result. Without options
 * the result is returned as it is, so default output stays a full-size PNG.
 */
export async function applyImageOutput(result: CallToolResult, options: IImageOutputOptions): Promise<CallToolResult> {
  if (options.max_size === undefined && options.format === undefined) return result;
  const content = await Promise.all(result.content.map(async (item) => {
    if (item.type !== "image") return item;
    const encoded = await encodeImage(`data:${item.mimeType};base64,${item.data}`, options);
    const match = /^data:([^;,]+);base64,(.*)$/.exec(encoded);
    if (!match) throw new Error("The re-encoded image is not a base64 data URL.");
    return { ...item, mimeType: match[1], data: match[2] };
  }));
  return { ...result, content };
}
