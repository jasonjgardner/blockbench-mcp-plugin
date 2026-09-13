/// <reference types="blockbench-types" />
import type { PbrChannel } from "./material-edit";

/** Lower-case extension routed to a TGA decoder instead of a browser data URL. */
const TGA_EXTENSION = ".tga";

/** Lower-case extension loaded as `image/png`; other non-TGA images load as JPEG. */
const PNG_EXTENSION = ".png";

/** Blockbench's optional host TGA decoder: fills `texture` from raw file bytes. */
type TgaDecoder = (bytes: Buffer, texture: Texture) => unknown;

/** Narrows an untyped host hook to a callable TGA decoder. */
function isTgaDecoder(value: unknown): value is TgaDecoder {
  return typeof value === "function";
}

/** Reads the `Texture.file_formats.tga.decode` hook newer Blockbench builds expose; typings omit it. */
function findHostTgaDecoder(): unknown {
  const formats: unknown = Reflect.get(Texture, "file_formats");
  const tga: unknown = formats && typeof formats === "object" ? Reflect.get(formats, "tga") : undefined;
  return tga && typeof tga === "object" ? Reflect.get(tga, "decode") : undefined;
}

/** Decodes TGA bytes with the host decoder, falling back to the bundled `Targa` library. */
async function decodeTgaInto(bytes: Buffer, texture: Texture): Promise<void> {
  const decode = findHostTgaDecoder();
  if (isTgaDecoder(decode)) {
    await decode(bytes, texture);
    return;
  }
  if (typeof Targa === "undefined") {
    throw new Error("This Blockbench version cannot decode TGA textures. Convert the referenced image to PNG.");
  }
  const image = new Targa();
  image.load(bytes);
  texture.fromDataURL(image.getDataURL());
}

/** Loads raw image file bytes into `texture` according to the file extension. */
async function loadImageBytes(texture: Texture, bytes: Buffer, extension: string): Promise<void> {
  if (extension === TGA_EXTENSION) return decodeTgaInto(bytes, texture);
  const mime = extension === PNG_EXTENSION ? "image/png" : "image/jpeg";
  texture.fromDataURL(`data:${mime};base64,${bytes.toString("base64")}`);
}

/** Resizes the texture and its backing canvas to the decoded image and paints the pixels. */
function syncCanvasToImage(texture: Texture): void {
  texture.width = texture.img.naturalWidth;
  texture.height = texture.img.naturalHeight;
  texture.canvas.width = texture.width;
  texture.canvas.height = texture.height;
  texture.canvas.getContext("2d")?.drawImage(texture.img, 0, 0);
}

/**
 * Waits for the texture's image element to decode, so broken image data fails
 * before any undo edit starts.
 *
 * @param texture - Texture whose `img` source was just assigned.
 * @param message - Tool-specific error message shown when decoding fails.
 * @throws `Error(message)` with the browser decode failure as `cause`.
 */
export async function decodeTextureImage(texture: Texture, message: string): Promise<void> {
  try {
    await texture.img.decode();
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}

/**
 * Loads a local PNG, JPEG, or TGA file into a detached texture (not yet added
 * to the project) so it can be added inside a single undo edit. A texture
 * already loaded from the same resolved path is returned instead.
 *
 * @param path - Local file path of the image.
 * @param channel - PBR channel stored on a newly created texture.
 * @param fs - Scoped file system from `requireNativeModule("fs")`.
 * @returns The existing project texture for `path`, or a new detached texture sized to the image.
 * @throws When the image cannot be decoded or has no pixels.
 */
export async function stageImportedImage(path: string, channel: PbrChannel, fs: ScopedFS): Promise<Texture> {
  const pathModule = requireNativeModule("path");
  const existing = Texture.all.find(texture => texture.path && pathModule.resolve(texture.path) === pathModule.resolve(path));
  if (existing) return existing;
  // Load bytes into a detached texture. fromPath would remove an existing
  // texture with the same path and rewrite its face references before undo.
  const texture = new Texture({ name: pathModule.basename(path), pbr_channel: channel });
  await loadImageBytes(texture, fs.readFileSync(path), pathModule.extname(path).toLowerCase());
  await decodeTextureImage(
    texture,
    `Cannot decode referenced image "${path}". Repair the image before importing the texture set.`
  );
  if (!texture.img.naturalWidth || !texture.img.naturalHeight) throw new Error(`Referenced image "${path}" has no pixels.`);
  syncCanvasToImage(texture);
  texture.path = path;
  texture.saved = true;
  return texture;
}
