/// <reference types="blockbench-types" />
import type { z } from "zod";
import { runUndoableEdit } from "@/lib/undo";
import { pbrChannelEnum, type colorSchema } from "@/lib/zodObjects";
import { commitMaterialEdit, type ITextureChange, type PbrChannel } from "./material-edit";
import { decodeTextureImage, stageImportedImage } from "./image-staging";

/** RGBA input accepted by tinycolor; `a` is a 0-1 fraction. */
interface ITinycolorRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The part of a tinycolor instance used to produce a canvas fill style. */
interface ITinycolorInstance {
  toRgbString(): string;
}

/** Blockbench bundles tinycolor as a runtime global, but blockbench-types does not declare it globally. */
declare const tinycolor: (value: string | ITinycolorRgba) => ITinycolorInstance;

/** `data` values with this prefix are decoded in memory; anything else is treated as a local file path. */
const IMAGE_DATA_URL_PREFIX = "data:image/";

/** Optional `file://` scheme stripped from desktop file paths. */
const FILE_URL_SCHEME = /^file:\/\//;

/** Largest 8-bit channel value: the opaque alpha default and the divisor for tinycolor's 0-1 alpha. */
const MAX_COLOR_BYTE = 255;

/** Color accepted by create_texture's `fill_color`: RGBA byte array, hex string, or color name. */
export type TextureFillColor = z.infer<typeof colorSchema>;

/** Normalizes a fill color through tinycolor into a lower-case `rgb()`/`rgba()` canvas style. */
function toCanvasFillStyle(fillColor: TextureFillColor): string {
  if (typeof tinycolor !== "function") {
    throw new Error("This Blockbench version does not provide tinycolor for fill_color. Pass image data instead.");
  }
  const color = Array.isArray(fillColor)
    ? tinycolor({ r: fillColor[0], g: fillColor[1], b: fillColor[2], a: (fillColor[3] ?? MAX_COLOR_BYTE) / MAX_COLOR_BYTE })
    : tinycolor(fillColor);
  return color.toRgbString().toLowerCase();
}

/** Fills the canvas with `fillColor`, or clears it to transparent when no color is given. */
function paintBlankCanvas(ctx: CanvasRenderingContext2D, texture: Texture, fillColor: TextureFillColor | undefined): void {
  if (!fillColor) {
    ctx.clearRect(0, 0, texture.width, texture.height);
    return;
  }
  ctx.fillStyle = toCanvasFillStyle(fillColor);
  ctx.fillRect(0, 0, texture.width, texture.height);
}

/** Paints a blank texture and commits the canvas as its source and layer data. */
function fillBlankTexture(texture: Texture, fillColor: TextureFillColor | undefined): void {
  const { ctx } = texture.getActiveCanvas();
  paintBlankCanvas(ctx, texture, fillColor);
  texture.updateSource(ctx.canvas.toDataURL("image/png", 1));
  texture.updateLayerChanges(true);
}

/** Loads an image data URL into `texture` and waits for it to decode. */
async function loadDataUrl(texture: Texture, data: string): Promise<void> {
  texture.fromDataURL(data);
  await decodeTextureImage(texture, "Cannot decode texture data URL. Provide valid image data.");
}

/** Stages a desktop image file as a new detached texture, rejecting paths that are already loaded. */
async function loadTextureFile(data: string, channel: PbrChannel): Promise<Texture> {
  if (Blockbench.isWeb) throw new Error("File paths require Blockbench desktop. Pass an image data URL instead.");
  const fs = requireNativeModule("fs");
  if (!fs) throw new Error("Local file access is unavailable.");
  const path = data.replace(FILE_URL_SCHEME, "");
  if (!fs.existsSync(path) || !fs.statSync(path).isFile()) throw new Error(`Texture file not found: ${path}`);
  const texture = await stageImportedImage(path, channel, fs);
  if (Texture.all.includes(texture)) {
    throw new Error("This image path is already loaded. Use the existing texture with assign_texture_channel or add_texture_group.");
  }
  return texture;
}

/**
 * Loads create_texture's pixel source into a texture that is not yet part of the project.
 *
 * @param blank - Detached texture sized from the tool arguments; used unless `data` is a file path.
 * @param data - Image data URL, local file path (desktop only), or `undefined` for a blank texture.
 * @param fillColor - Fill for a blank texture; the schema forbids combining it with `data`.
 * @param channel - PBR channel stored on a texture staged from a file.
 * @returns The texture carrying the pixels: `blank`, or a newly staged file texture.
 * @throws When a file path is used on web, is missing or already loaded, or image data cannot be decoded.
 */
export async function loadTextureData(
  blank: Texture,
  data: string | undefined,
  fillColor: TextureFillColor | undefined,
  channel: PbrChannel
): Promise<Texture> {
  if (!data) {
    fillBlankTexture(blank, fillColor);
    return blank;
  }
  if (!data.startsWith(IMAGE_DATA_URL_PREFIX)) return loadTextureFile(data, channel);
  await loadDataUrl(blank, data);
  return blank;
}

/** Adds the texture to a group in one material edit, detaching any material map in the same channel. */
function addGroupedTexture(texture: Texture, textureGroup: TextureGroup): void {
  const displaced: ITextureChange[] = textureGroup.is_material
    ? textureGroup.getTextures()
      .filter(existing => existing.pbr_channel === texture.pbr_channel)
      .map(existing => ({ texture: existing, group: "", channel: pbrChannelEnum.parse(existing.pbr_channel) }))
    : [];
  const changes: ITextureChange[] = [
    ...displaced,
    { texture, group: textureGroup.uuid, channel: pbrChannelEnum.parse(texture.pbr_channel) },
  ];
  commitMaterialEdit(textureGroup, changes, {}, "Agent created texture", [texture]);
}

/** Adds an ungrouped texture with its bitmap in one undo edit. */
function addUngroupedTexture(texture: Texture): void {
  // Starts empty and is filled inside the edit: Blockbench re-reads this aspect
  // array, so undo removes the new texture and redo restores its bitmap.
  const created: Texture[] = [];
  runUndoableEdit({ textures: created, bitmap: true }, "Agent created texture", () => {
    created.push(texture);
    texture.add(false);
    Canvas.updateAll();
  });
}

/**
 * Adds a newly created texture to the project as one undoable edit.
 *
 * @param texture - Fully configured detached texture.
 * @param textureGroup - Optional destination group; material groups detach the texture previously in the same channel.
 * @throws Material validation errors, or the original error after reverting a failed edit.
 */
export function addCreatedTexture(texture: Texture, textureGroup: TextureGroup | undefined): void {
  if (textureGroup) {
    addGroupedTexture(texture, textureGroup);
    return;
  }
  addUngroupedTexture(texture);
}
