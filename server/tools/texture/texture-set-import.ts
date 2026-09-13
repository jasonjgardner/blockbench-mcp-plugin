/// <reference types="blockbench-types" />
import { z } from "zod";
import { colorByte } from "@/lib/zodObjects";
import {
  commitMaterialEdit,
  requireTextureProject,
  type IMaterialValues,
  type PbrChannel,
} from "./material-edit";
import { stageImportedImage } from "./image-staging";

/** File suffix Bedrock uses for material definitions; stripped to name the imported material. */
const TEXTURE_SET_FILE_SUFFIX = ".texture_set.json";

/** Appended to the texture-set base name, matching the material names Blockbench's own importer creates. */
const IMPORTED_MATERIAL_NAME_SUFFIX = ".png material";

/** Image extensions a layer may reference; extensionless names are tried in this order. */
const TEXTURE_SET_IMAGE_EXTENSIONS = [".tga", ".png", ".jpg", ".jpeg"] as const;

/**
 * Subsurface value recorded when a MERS layer references an image. The map
 * carries per-pixel subsurface; Blockbench only needs a truthy value to export
 * the layer as MERS again, and its native importer uses the same value.
 */
const IMAGE_SUBSURFACE_VALUE = 1;

/** Alpha byte used when a uniform color has no alpha component. */
const OPAQUE_ALPHA_BYTE = 255;

/** UTF-8 byte order mark some editors prepend, which `JSON.parse` rejects. */
const LEADING_BYTE_ORDER_MARK = /^﻿/;

/** Uniform color hex: `#RRGGBB`, or `#AARRGGBB` with alpha first as Bedrock stores it. */
const COLOR_HEX_PATTERN = /^#[\da-f]{6}(?:[\da-f]{2})?$/i;

/** Uniform MER hex: `#MMEERR` (metalness, emissive, roughness). */
const MER_HEX_PATTERN = /^#[\da-f]{6}$/i;

/** Uniform MERS hex with the subsurface byte first, like alpha in `#AARRGGBB`: `#SSMMEERR`. */
const MERS_HEX_PATTERN = /^#[\da-f]{8}$/i;

const textureSetByte = colorByte().int();
const textureSetRgb = z.tuple([textureSetByte, textureSetByte, textureSetByte]);
const textureSetRgba = z.tuple([textureSetByte, textureSetByte, textureSetByte, textureSetByte]);
const textureSetReference = z.string().min(1)
  .refine(value => !value.startsWith("#"), "Expected an image name, not a hexadecimal value.");
const textureSetHex = z.string().regex(COLOR_HEX_PATTERN, "Use #RRGGBB or #AARRGGBB hexadecimal values.");
const textureSetLayersSchema = z.object({
  color: z.union([textureSetReference, textureSetRgba, textureSetHex]),
  normal: textureSetReference.optional(),
  heightmap: textureSetReference.optional(),
  metalness_emissive_roughness: z.union([textureSetReference, textureSetRgb, z.string().regex(MER_HEX_PATTERN)]).optional(),
  metalness_emissive_roughness_subsurface: z
    .union([textureSetReference, textureSetRgba, z.string().regex(MERS_HEX_PATTERN)])
    .optional(),
}).strict()
  .refine(data => !(data.normal && data.heightmap), "Normal and heightmap layers cannot coexist.")
  .refine(
    data => !(data.metalness_emissive_roughness !== undefined && data.metalness_emissive_roughness_subsurface !== undefined),
    "MER and MERS layers cannot coexist."
  );
const textureSetSchema = z.object({
  format_version: z.enum(["1.16.100", "1.21.30"]),
  "minecraft:texture_set": textureSetLayersSchema,
}).strict();

/** Validated `minecraft:texture_set` layers of a texture_set.json file. */
type TextureSetLayers = z.infer<typeof textureSetLayersSchema>;

/** A referenced image file resolved on disk, with the channel it will occupy. */
interface IImportedImage {
  path: string;
  channel: PbrChannel;
}

/** One texture_set layer mapped to a Blockbench channel: image name, hex string, byte array, or absent. */
interface ITextureSetSource {
  channel: PbrChannel;
  source: string | number[] | undefined;
  subsurface?: boolean;
}

/** Images to stage and uniform values to apply for one texture set. */
interface IResolvedTextureSet {
  images: IImportedImage[];
  values: IMaterialValues;
}

/** Converts uniform layer bytes into material values; only color and MER layers accept uniforms. */
const UNIFORM_VALUE_BUILDERS: Partial<Record<PbrChannel, (uniform: number[]) => IMaterialValues>> = {
  color: uniform => ({ color_value: [uniform[0], uniform[1], uniform[2], uniform[3] ?? OPAQUE_ALPHA_BYTE] }),
  mer: uniform => ({ mer_value: [uniform[0], uniform[1], uniform[2]] }),
};

/** Parses `#RRGGBB` / `#AARRGGBB` into bytes, moving a leading fourth byte to the end. */
function hexValues(value: string): number[] {
  const bytes = (value.slice(1).match(/.{2}/g) ?? []).map(byte => Number.parseInt(byte, 16));
  if (bytes.length === 4) return [bytes[1], bytes[2], bytes[3], bytes[0]];
  return bytes;
}

/** Checks desktop, suffix, file access, and existence before reading a texture set. */
function openTextureSetFile(path: string): ScopedFS {
  if (Blockbench.isWeb) throw new Error("import_texture_set requires Blockbench desktop to read local files.");
  if (!path.endsWith(TEXTURE_SET_FILE_SUFFIX)) throw new Error(`Path must end with '${TEXTURE_SET_FILE_SUFFIX}'.`);
  const fs = requireNativeModule("fs");
  if (!fs) {
    throw new Error("Local file access is unavailable. Enable the plugin's file access before importing a texture set.");
  }
  if (!fs.existsSync(path) || !fs.statSync(path).isFile()) throw new Error(`Texture set file not found: ${path}`);
  return fs;
}

/** Reads and schema-validates a texture set, returning its layers. */
function readTextureSet(path: string, fs: ScopedFS): TextureSetLayers {
  const parsed = textureSetSchema.safeParse(parseTextureSetJson(path, fs));
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid texture set: ${issues}`);
  }
  return parsed.data["minecraft:texture_set"];
}

/** Parses the file as JSON, tolerating a leading byte order mark. */
function parseTextureSetJson(path: string, fs: ScopedFS): unknown {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8").replace(LEADING_BYTE_ORDER_MARK, ""));
  } catch (error) {
    throw new Error(`Invalid JSON in "${path}". Fix the texture set before importing it.`, { cause: error });
  }
}

/** Maps texture_set layer keys onto Blockbench channels; MER and MERS share the `mer` channel. */
function listTextureSetSources(layers: TextureSetLayers): ITextureSetSource[] {
  return [
    { channel: "color", source: layers.color },
    { channel: "normal", source: layers.normal },
    { channel: "height", source: layers.heightmap },
    {
      channel: "mer",
      source: layers.metalness_emissive_roughness ?? layers.metalness_emissive_roughness_subsurface,
      subsurface: layers.metalness_emissive_roughness_subsurface !== undefined,
    },
  ];
}

/** Resolves an image reference next to the texture set, trying known extensions for extensionless names. */
function findReferencedImage(setPath: string, reference: string, channel: PbrChannel, fs: ScopedFS): string {
  const pathModule = requireNativeModule("path");
  const base = pathModule.resolve(pathModule.dirname(setPath), reference);
  const hasExtension = TEXTURE_SET_IMAGE_EXTENSIONS.some(extension => base.toLowerCase().endsWith(extension));
  const candidates = hasExtension ? [base] : TEXTURE_SET_IMAGE_EXTENSIONS.map(extension => base + extension);
  const imagePath = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!imagePath) {
    throw new Error(`Missing ${channel} image "${reference}" referenced by "${setPath}". Add the image before importing.`);
  }
  return imagePath;
}

/** Derives the uniform material values (and subsurface flag) contributed by one layer. */
function materialValuesFor({ channel, source, subsurface }: ITextureSetSource): IMaterialValues {
  if (source === undefined) return {};
  if (typeof source === "string" && !source.startsWith("#")) {
    return subsurface ? { subsurface_value: IMAGE_SUBSURFACE_VALUE } : {};
  }
  const uniform = typeof source === "string" ? hexValues(source) : source;
  return {
    ...UNIFORM_VALUE_BUILDERS[channel]?.(uniform),
    ...(subsurface ? { subsurface_value: uniform[3] ?? 0 } : {}),
  };
}

/** Splits layers into image files to stage and merged uniform values, failing on the first missing image. */
function resolveTextureSetSources(layers: TextureSetLayers, setPath: string, fs: ScopedFS): IResolvedTextureSet {
  const sources = listTextureSetSources(layers);
  const images = sources.flatMap(({ channel, source }) =>
    typeof source === "string" && !source.startsWith("#")
      ? [{ path: findReferencedImage(setPath, source, channel, fs), channel }]
      : []
  );
  const values = sources.reduce<IMaterialValues>((merged, source) => ({ ...merged, ...materialValuesFor(source) }), {});
  return { images, values };
}

/** Enforces distinct image files and Blockbench's color-with-MER requirement before staging. */
function assertImportableImages(images: IImportedImage[]): void {
  if (new Set(images.map(image => image.path)).size !== images.length) {
    throw new Error("Each texture set channel must reference a different image.");
  }
  if (images.some(image => image.channel === "mer") && !images.some(image => image.channel === "color")) {
    throw new Error("Blockbench requires a color image when importing a MER image. Use a color image or uniform MER values.");
  }
}

/** Names the material after the file, e.g. `stone.texture_set.json` becomes `stone.png material`. */
function importedMaterialName(path: string): string {
  const fileName = requireNativeModule("path").basename(path);
  return fileName.slice(0, -TEXTURE_SET_FILE_SUFFIX.length) + IMPORTED_MATERIAL_NAME_SUFFIX;
}

/**
 * Imports a Bedrock `.texture_set.json` as a new PBR material in one undo edit.
 * File, JSON, schema, image, and channel validation plus image decoding all
 * happen before the edit, so a failure leaves the project unchanged.
 *
 * @param path - Desktop file path ending in `.texture_set.json`.
 * @returns The newly added material group, marked as saved.
 * @throws When on web, the file/JSON/schema is invalid, images are missing or
 *   shared, a MER image lacks a color image, or the active project changes mid-load.
 */
export async function importMaterial(path: string): Promise<TextureGroup> {
  requireTextureProject();
  const fs = openTextureSetFile(path);
  const { images, values } = resolveTextureSetSources(readTextureSet(path, fs), path, fs);
  assertImportableImages(images);
  const project = Project;
  const textures = await Promise.all(images.map(image => stageImportedImage(image.path, image.channel, fs)));
  if (Project !== project) {
    throw new Error("The active project changed while loading images. Select the intended project and import again.");
  }
  const group = new TextureGroup({ name: importedMaterialName(path), is_material: true });
  const changes = textures.map((texture, index) => ({ texture, group: group.uuid, channel: images[index].channel }));
  const newTextures = textures.filter(texture => !Texture.all.includes(texture));
  commitMaterialEdit(group, changes, values, "Agent imported texture set", newTextures, true);
  return group;
}
