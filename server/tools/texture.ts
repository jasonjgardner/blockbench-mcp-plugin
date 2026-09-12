/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import {
  imageContent,
  findElementOrThrow,
  findTextureOrThrow,
  findTextureGroupOrThrow,
  getChannelTextureInfo,
} from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { updateMaterialPreview } from "@/lib/material-preview";
import {
  colorSchema,
  elementIdSchema,
  textureIdSchema,
  textureIdOptionalSchema,
  pbrChannelEnum,
  renderModeEnum,
  renderSidesEnum,
} from "@/lib/zodObjects";

// ============================================================================
// Texture Tool Parameter Schemas
// ============================================================================

export const createTextureParameters = z
  .object({
    name: z.string(),
    width: z.number().min(16).max(4096).default(16),
    height: z.number().min(16).max(4096).default(16),
    data: z
      .string()
      .optional()
      .describe("Path to the image file or data URL."),
    group: z.string().optional(),
    fill_color: colorSchema
      .optional()
      .describe("RGBA color to fill the texture, as tuple or HEX string."),
    layer_name: z
      .string()
      .optional()
      .describe(
        "Name of the texture layer. Required if fill_color is set."
      ),
    pbr_channel: pbrChannelEnum
      .optional()
      .describe(
        "PBR channel to use for the texture. Color, normal, height, or Metalness/Emissive/Roughness (MER) map."
      ),
    render_mode: renderModeEnum
      .optional()
      .default("default")
      .describe(
        "Render mode for the texture. Default, emissive, additive, or layered."
      ),
    render_sides: renderSidesEnum
      .optional()
      .default("auto")
      .describe("Render sides for the texture. Auto, front, or double."),
  })
  .refine((params) => !(params.data && params.fill_color), {
    message:
      "The 'data' and 'fill_color' properties cannot both be defined.",
    path: ["data", "fill_color"],
  })
  .refine((params) => !(params.fill_color && !params.layer_name), {
    message:
      "The 'layer_name' property is required when 'fill_color' is set.",
    path: ["layer_name", "fill_color"],
  })
  .refine(
    ({ pbr_channel, group }) => (pbr_channel && group) || !pbr_channel,
    {
      message:
        "The 'group' property is required when 'pbr_channel' is set.",
      path: ["group", "pbr_channel"],
    }
  );

export const applyTextureParameters = z.object({
  id: elementIdSchema.describe("ID or name of the element to apply the texture to."),
  texture: textureIdSchema.describe("ID or name of the texture to apply."),
  applyTo: z
    .enum(["all", "blank", "none"])
    .describe("Apply texture to element or group.")
    .optional()
    .default("blank"),
});

export const addTextureGroupParameters = z.object({
  name: z.string(),
  textures: z
    .array(z.string())
    .optional()
    .describe("Array of texture IDs or names to add to the group."),
  is_material: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether the texture group is a PBR material or not."),
});

export const listTexturesParameters = z.object({});

export const getTextureParameters = z.object({
  texture: textureIdOptionalSchema,
});

export const activateTextureParameters = z.object({
  texture: textureIdSchema.describe(
    "Texture ID, UUID, or name to activate in the texture panel."
  ),
});

/** Create a material with one texture per channel and reversible group membership. */
export const createPbrMaterialParameters = z.object({
  name: z.string().describe("Name of the material."),
  color_texture: z
    .string()
    .optional()
    .describe("Texture ID/name for the color (albedo) channel."),
  normal_texture: z
    .string()
    .optional()
    .describe("Texture ID/name for the normal map channel."),
  height_texture: z
    .string()
    .optional()
    .describe("Texture ID/name for the height/displacement map channel."),
  mer_texture: z
    .string()
    .optional()
    .describe(
      "Texture ID/name for the MER (Metalness/Emissive/Roughness) channel."
    ),
  color_value: z
    .tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)])
    .optional()
    .describe(
      "Uniform RGBA color [R,G,B,A] when no color texture is provided."
    ),
  mer_value: z
    .tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)])
    .optional()
    .describe(
      "Uniform MER values [Metalness, Emissive, Roughness] (0-255) when no MER texture is provided."
    ),
  subsurface_value: z
    .number()
    .min(0)
    .max(255)
    .optional()
    .describe(
      "Subsurface scattering value (0-255) for Bedrock 1.21.30+ materials."
    ),
}).refine(({ normal_texture, height_texture }) => !(normal_texture && height_texture), {
  message: "Use either normal_texture or height_texture, not both.",
  path: ["height_texture"],
});

/** Update channel assignments; use 'none' to detach a map before using a uniform value. */
export const configureMaterialParameters = z.object({
  material: z.string().describe("Material name or UUID to configure."),
  color_texture: z
    .string()
    .optional()
    .describe(
      "Texture ID/name for the color channel, or 'none' to use uniform color."
    ),
  normal_texture: z
    .string()
    .optional()
    .describe(
      "Texture ID/name for the normal map, or 'none' to remove."
    ),
  height_texture: z
    .string()
    .optional()
    .describe(
      "Texture ID/name for the height map, or 'none' to remove."
    ),
  mer_texture: z
    .string()
    .optional()
    .describe(
      "Texture ID/name for MER channel, or 'none' to use uniform values."
    ),
  color_value: z
    .tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)])
    .optional()
    .describe("Uniform RGBA color [R,G,B,A] when no color texture."),
  mer_value: z
    .tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)])
    .optional()
    .describe(
      "Uniform MER values [Metalness, Emissive, Roughness] (0-255)."
    ),
  subsurface_value: z
    .number()
    .min(0)
    .max(255)
    .optional()
    .describe("Subsurface scattering value (0-255)."),
}).refine(({ normal_texture, height_texture }) => !(normal_texture && normal_texture !== "none" && height_texture && height_texture !== "none"), {
  message: "Use either normal_texture or height_texture; set the other channel to 'none' when replacing it.",
  path: ["height_texture"],
});

export const listMaterialsParameters = z.object({});

export const getMaterialInfoParameters = z.object({
  material: z.string().describe("Material name or UUID."),
});

export const importTextureSetParameters = z.object({
  path: z
    .string()
    .describe(
      "Path to the .texture_set.json file to import."
    ),
});

export const assignTextureChannelParameters = z.object({
  material: z.string().describe("Material name or UUID."),
  texture: textureIdSchema.describe("Texture name or UUID to assign."),
  channel: pbrChannelEnum.describe("PBR channel to assign the texture to."),
});

export const saveMaterialConfigParameters = z.object({
  material: z.string().describe("Material name or UUID to save."),
});

// ============================================================================
// Texture Tool Docs
// ============================================================================

export const textureToolDocs: ToolSpec[] = [
  {
    name: "create_texture",
    description: "Creates a new texture with the given name and size.",
    annotations: {
      title: "Create Texture",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: createTextureParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "apply_texture",
    description:
      "Applies the given texture to the element with the specified ID.",
    annotations: {
      title: "Apply Texture",
      destructiveHint: true,
    },
    parameters: applyTextureParameters,
    status: STATUS_STABLE,
  },
  {
    name: "add_texture_group",
    description: "Adds a reversible texture group. All texture references must exist. Material groups require one texture per channel, either normal or height, and a color map alongside a MER map; use is_material=false for ordinary grouping.",
    annotations: {
      title: "Add Texture Group",
      destructiveHint: true,
    },
    parameters: addTextureGroupParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "list_textures",
    description: "Returns a list of all textures in the Blockbench editor.",
    annotations: {
      title: "List Textures",
      readOnlyHint: true,
    },
    parameters: listTexturesParameters,
    status: STATUS_STABLE,
  },
  {
    name: "get_texture",
    description:
      "Returns the image data of the given texture or default texture.",
    annotations: {
      title: "Get Texture",
      readOnlyHint: true,
    },
    parameters: getTextureParameters,
    status: STATUS_STABLE,
  },
  {
    name: "create_pbr_material",
    description:
      "Creates a new PBR material (texture group with is_material=true) and optionally assigns textures to PBR channels. Requires a PBR-capable format, distinct textures per channel, either normal or height, and a color texture alongside a MER texture. Uniform values require the corresponding map to be absent. Creation and texture moves are one undoable edit.",
    annotations: {
      title: "Create PBR Material",
      destructiveHint: true,
    },
    parameters: createPbrMaterialParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "configure_material",
    description:
      "Configures a PBR material in one undoable edit. Replaced maps are detached without deleting their textures. Use 'none' to clear a channel before using uniform values or switching between normal and height; a MER map requires a color map.",
    annotations: {
      title: "Configure Material",
      destructiveHint: true,
    },
    parameters: configureMaterialParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "list_materials",
    description:
      "Lists all PBR materials (texture groups with is_material=true) and their assigned textures per channel.",
    annotations: {
      title: "List Materials",
      readOnlyHint: true,
    },
    parameters: listMaterialsParameters,
    status: STATUS_STABLE,
  },
  {
    name: "get_material_info",
    description:
      "Gets detailed information about a PBR material including the compiled texture_set.json preview for Bedrock export.",
    annotations: {
      title: "Get Material Info",
      readOnlyHint: true,
    },
    parameters: getMaterialInfoParameters,
    status: STATUS_STABLE,
  },
  {
    name: "import_texture_set",
    description:
      "Imports a Minecraft Bedrock texture_set.json on desktop. Validates supported JSON and decodes referenced images before one undoable edit. Returns JSON with material name/UUID and path. Reuses already loaded image paths without deleting textures. Normal and height, or MER and MERS, cannot coexist; MER images require a color image.",
    annotations: {
      title: "Import Texture Set",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: importTextureSetParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "assign_texture_channel",
    description:
      "Assigns a texture to one PBR channel in a single undoable edit. Detaches the previous map without deleting it or changing its channel. Normal and height cannot coexist; a MER map requires a color map, including in the source material after moving textures.",
    annotations: {
      title: "Assign Texture Channel",
      destructiveHint: true,
    },
    parameters: assignTextureChannelParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "save_material_config",
    description:
      "Saves the material's texture_set.json file to disk (Bedrock format). Requires the color texture to have a valid file path.",
    annotations: {
      title: "Save Material Config",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: saveMaterialConfigParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "activate_texture",
    description:
      "Activates the given texture in the Blockbench texture panel so that subsequent paint operations (draw_shape_tool, paint_with_brush, gradient_tool, etc.) target it. Most paint tools already call this internally when a texture_id is provided, but you can invoke it explicitly to pin the active texture across multiple calls.",
    annotations: {
      title: "Activate Texture",
      destructiveHint: false,
      idempotentHint: true,
    },
    parameters: activateTextureParameters,
    status: STATUS_STABLE,
  },
];

// ============================================================================
// Tool Registration
// ============================================================================

type PbrChannel = z.infer<typeof pbrChannelEnum>;
type MaterialValues = Pick<z.infer<typeof configureMaterialParameters>, "color_value" | "mer_value" | "subsurface_value">;
type MaterialChannels = Partial<Record<`${PbrChannel}_texture`, string>>;
type TextureChange = { texture: Texture; group: string; channel: PbrChannel };
type MaterialConfig = TextureGroup["material_config"] & { subsurface_value: number };
const materialChannels: PbrChannel[] = ["color", "normal", "height", "mer"];

function requireTextureProject(material = true): void {
  if (typeof Project === "undefined" || !Project) throw new Error("Open a project before editing textures or materials.");
  if (material && !Format.pbr) throw new Error("The current format does not support PBR materials. Use get_capabilities to choose a format with pbr support, such as 'free'.");
}

function materialConfig(group: TextureGroup): MaterialConfig {
  // Subsurface is a host property since Bedrock 1.21.30; upstream typings omit it.
  return group.material_config as MaterialConfig;
}

function findMaterial(id: string): TextureGroup {
  requireTextureProject();
  const group = findTextureGroupOrThrow(id);
  if (!group.is_material) throw new Error(`Texture group "${id}" is not a PBR material. Use create_pbr_material or add_texture_group with is_material=true.`);
  return group;
}

function uniqueTextures(textures: Texture[]): Texture[] {
  return [...new Map(textures.map(texture => [texture.uuid, texture])).values()];
}

function planChannels(group: TextureGroup, channels: MaterialChannels): TextureChange[] {
  const assignments = materialChannels.flatMap(channel => {
    const id = channels[`${channel}_texture`];
    if (id === undefined || id === "none") return [];
    return [{ texture: findTextureOrThrow(id), group: group.uuid, channel }];
  });
  if (uniqueTextures(assignments.map(change => change.texture)).length !== assignments.length) {
    throw new Error("A texture can occupy only one PBR channel. Use a different texture for each channel.");
  }
  const displaced = group.getTextures().flatMap(texture => {
    const channel = pbrChannelEnum.parse(texture.pbr_channel);
    if (channels[`${channel}_texture`] === undefined || assignments.some(change => change.texture.uuid === texture.uuid)) return [];
    return [{ texture, group: "", channel }];
  });
  return [...displaced, ...assignments];
}

function affectedGroups(group: TextureGroup, changes: TextureChange[]): TextureGroup[] {
  const sourceIds = new Set(changes.map(change => change.texture.group));
  return [...new Map([group, ...TextureGroup.all.filter(source => sourceIds.has(source.uuid))].map(source => [source.uuid, source])).values()];
}

function projectedChannels(group: TextureGroup, changes: TextureChange[]): PbrChannel[] {
  const changed = new Set(changes.map(change => change.texture.uuid));
  return [
    ...group.getTextures().filter(texture => !changed.has(texture.uuid)).map(texture => pbrChannelEnum.parse(texture.pbr_channel)),
    ...changes.filter(change => change.group === group.uuid).map(change => change.channel),
  ];
}

function validateMaterialChanges(group: TextureGroup, changes: TextureChange[], values: MaterialValues = {}): TextureGroup[] {
  const groups = affectedGroups(group, changes);
  groups.filter(candidate => candidate.is_material).forEach(candidate => {
    const channels = projectedChannels(candidate, changes);
    if (new Set(channels).size !== channels.length) throw new Error(`Material "${candidate.name}" would have multiple textures in one channel. Assign one texture per channel or use is_material=false for ordinary texture groups.`);
    if (channels.includes("normal") && channels.includes("height")) throw new Error(`Material "${candidate.name}" cannot use normal and height maps together. Set normal_texture or height_texture to 'none' in configure_material before switching.`);
    if (channels.includes("mer") && !channels.includes("color")) throw new Error(`Material "${candidate.name}" needs a color texture when using a MER texture in Blockbench. Assign a color map or remove the MER map and use mer_value.`);
  });
  const targetChannels = projectedChannels(group, changes);
  if (values.color_value && targetChannels.includes("color")) throw new Error("color_value requires no color texture. Set color_texture to 'none' in the same configure_material call.");
  if (values.mer_value && targetChannels.includes("mer")) throw new Error("mer_value requires no MER texture. Set mer_texture to 'none' in the same configure_material call.");
  return groups;
}

function applyMaterialValues(group: TextureGroup, values: MaterialValues): void {
  const config = materialConfig(group);
  if (values.color_value) config.color_value = [...values.color_value];
  if (values.mer_value) config.mer_value = [...values.mer_value];
  if (values.subsurface_value !== undefined) config.subsurface_value = values.subsurface_value;
}

function commitMaterialEdit(group: TextureGroup, changes: TextureChange[], values: MaterialValues, message: string, createdTextures: Texture[] = [], saved = false): void {
  const groups = validateMaterialChanges(group, changes, values);
  const isNewGroup = !TextureGroup.all.includes(group);
  const trackedGroups = groups.filter(candidate => candidate !== group || !isNewGroup);
  const trackedTextures = uniqueTextures(changes.map(change => change.texture)).filter(texture => !createdTextures.includes(texture));
  // These mutable aspect arrays are intentional: cancellation and the final
  // snapshot must include entities created after the initial snapshot.
  const aspects = { textures: trackedTextures, texture_groups: trackedGroups };
  Undo.initEdit(aspects);
  try {
    if (isNewGroup) {
      trackedGroups.push(group);
      group.add();
    }
    createdTextures.forEach(texture => {
      trackedTextures.push(texture);
      const usedIds = new Set(Texture.all.map(existing => existing.id));
      texture.id = Array.from({ length: Texture.all.length + 1 }, (_, index) => String(index)).find(id => !usedIds.has(id)) ?? texture.uuid;
      const added = texture.add(false);
      if (added !== texture) throw new Error(`Texture "${texture.name}" could not be added independently. Import using unique image paths.`);
    });
    changes.forEach(change => change.texture.extend({ group: change.group, pbr_channel: change.channel }));
    applyMaterialValues(group, values);
    groups.filter(candidate => candidate.is_material).forEach(candidate => {
      candidate.material_config.saved = candidate === group ? saved : false;
      updateMaterialPreview(candidate);
    });
    Canvas.updateAll();
    Undo.finishEdit(message);
  } catch (error) {
    (Undo.cancelEdit as (revertChanges?: boolean) => void)(true);
    throw error;
  }
}

const textureSetByte = z.number().int().min(0).max(255);
const textureSetRgb = z.tuple([textureSetByte, textureSetByte, textureSetByte]);
const textureSetRgba = z.tuple([textureSetByte, textureSetByte, textureSetByte, textureSetByte]);
const textureSetReference = z.string().min(1).refine(value => !value.startsWith("#"), "Expected an image name, not a hexadecimal value.");
const textureSetHex = z.string().regex(/^#[\da-f]{6}(?:[\da-f]{2})?$/i, "Use #RRGGBB or #AARRGGBB hexadecimal values.");
const textureSetSchema = z.object({
  format_version: z.enum(["1.16.100", "1.21.30"]),
  "minecraft:texture_set": z.object({
    color: z.union([textureSetReference, textureSetRgba, textureSetHex]),
    normal: textureSetReference.optional(),
    heightmap: textureSetReference.optional(),
    metalness_emissive_roughness: z.union([textureSetReference, textureSetRgb, z.string().regex(/^#[\da-f]{6}$/i)]).optional(),
    metalness_emissive_roughness_subsurface: z.union([textureSetReference, textureSetRgba, z.string().regex(/^#[\da-f]{8}$/i)]).optional(),
  }).strict().refine(data => !(data.normal && data.heightmap), "Normal and heightmap layers cannot coexist.")
    .refine(data => !(data.metalness_emissive_roughness !== undefined && data.metalness_emissive_roughness_subsurface !== undefined), "MER and MERS layers cannot coexist."),
}).strict();

type ImportedImage = { path: string; channel: PbrChannel };

function hexValues(value: string): number[] {
  const bytes = (value.slice(1).match(/.{2}/g) ?? []).map(byte => Number.parseInt(byte, 16));
  if (bytes.length === 4) return [bytes[1], bytes[2], bytes[3], bytes[0]];
  return bytes;
}

async function stageImportedImage(path: string, channel: PbrChannel, fs: ScopedFS): Promise<Texture> {
  const pathModule = requireNativeModule("path");
  const existing = Texture.all.find(texture => texture.path && pathModule.resolve(texture.path) === pathModule.resolve(path));
  if (existing) return existing;
  // Load bytes into a detached texture. fromPath would remove an existing
  // texture with the same path and rewrite its face references before undo.
  const texture = new Texture({ name: pathModule.basename(path), pbr_channel: channel });
  const bytes = fs.readFileSync(path);
  const extension = pathModule.extname(path).toLowerCase();
  if (extension === ".tga") {
    const decoder: unknown = Reflect.get(Texture, "file_formats");
    const tga: unknown = decoder && typeof decoder === "object" ? Reflect.get(decoder, "tga") : undefined;
    const decode: unknown = tga && typeof tga === "object" ? Reflect.get(tga, "decode") : undefined;
    if (typeof decode === "function") {
      await decode(bytes, texture);
    }
    if (typeof decode !== "function") {
      if (typeof Targa === "undefined") throw new Error("This Blockbench version cannot decode TGA textures. Convert the referenced image to PNG.");
      const image = new Targa();
      image.load(bytes);
      texture.fromDataURL(image.getDataURL());
    }
  }
  if (extension !== ".tga") {
    const mime = extension === ".png" ? "image/png" : "image/jpeg";
    texture.fromDataURL(`data:${mime};base64,${bytes.toString("base64")}`);
  }
  try {
    await texture.img.decode();
  } catch {
    throw new Error(`Cannot decode referenced image "${path}". Repair the image before importing the texture set.`);
  }
  if (!texture.img.naturalWidth || !texture.img.naturalHeight) throw new Error(`Referenced image "${path}" has no pixels.`);
  texture.width = texture.img.naturalWidth;
  texture.height = texture.img.naturalHeight;
  texture.canvas.width = texture.width;
  texture.canvas.height = texture.height;
  texture.canvas.getContext("2d")?.drawImage(texture.img, 0, 0);
  texture.path = path;
  texture.saved = true;
  return texture;
}

async function importMaterial(path: string): Promise<TextureGroup> {
  requireTextureProject();
  if (Blockbench.isWeb) throw new Error("import_texture_set requires Blockbench desktop to read local files.");
  if (!path.endsWith(".texture_set.json")) throw new Error("Path must end with '.texture_set.json'.");
  const fs = requireNativeModule("fs");
  if (!fs) throw new Error("Local file access is unavailable. Enable the plugin's file access before importing a texture set.");
  if (!fs.existsSync(path) || !fs.statSync(path).isFile()) throw new Error(`Texture set file not found: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Invalid JSON in "${path}". Fix the texture set before importing it.`);
  }
  const parsed = textureSetSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid texture set: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const data = parsed.data["minecraft:texture_set"];
  const pathModule = requireNativeModule("path");
  const values: MaterialValues = {};
  const images: ImportedImage[] = [];
  const sources: Array<{ channel: PbrChannel; source: string | number[] | undefined; subsurface?: boolean }> = [
    { channel: "color", source: data.color },
    { channel: "normal", source: data.normal },
    { channel: "height", source: data.heightmap },
    { channel: "mer", source: data.metalness_emissive_roughness ?? data.metalness_emissive_roughness_subsurface, subsurface: data.metalness_emissive_roughness_subsurface !== undefined },
  ];
  sources.forEach(({ channel, source, subsurface }) => {
    if (source === undefined) return;
    if (typeof source === "string" && !source.startsWith("#")) {
      const base = pathModule.resolve(pathModule.dirname(path), source);
      const candidates = /\.(?:png|tga|jpg|jpeg)$/i.test(base) ? [base] : [".tga", ".png", ".jpg", ".jpeg"].map(extension => base + extension);
      const imagePath = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!imagePath) throw new Error(`Missing ${channel} image "${source}" referenced by "${path}". Add the image before importing.`);
      images.push({ path: imagePath, channel });
      if (subsurface) values.subsurface_value = 1;
      return;
    }
    const uniform = typeof source === "string" ? hexValues(source) : source;
    if (channel === "color") values.color_value = [uniform[0], uniform[1], uniform[2], uniform[3] ?? 255];
    if (channel === "mer") values.mer_value = [uniform[0], uniform[1], uniform[2]];
    if (subsurface) values.subsurface_value = uniform[3] ?? 0;
  });
  if (new Set(images.map(image => image.path)).size !== images.length) throw new Error("Each texture set channel must reference a different image.");
  if (images.some(image => image.channel === "mer") && !images.some(image => image.channel === "color")) throw new Error("Blockbench requires a color image when importing a MER image. Use a color image or uniform MER values.");
  const project = Project;
  const textures = await Promise.all(images.map(image => stageImportedImage(image.path, image.channel, fs)));
  if (Project !== project) throw new Error("The active project changed while loading images. Select the intended project and import again.");
  const group = new TextureGroup({ name: pathModule.basename(path).replace(/\.texture_set\.json$/, ".png material"), is_material: true });
  const changes = textures.map((texture, index) => ({ texture, group: group.uuid, channel: images[index].channel }));
  const newTextures = textures.filter(texture => !Texture.all.includes(texture));
  commitMaterialEdit(group, changes, values, "Agent imported texture set", newTextures, true);
  return group;
}

/** Register texture editing and material tools with validated, reversible PBR changes. */
export function registerTextureTools() {
  createTool(textureToolDocs[0].name, {
    ...textureToolDocs[0],
    parameters: createTextureParameters,
    async execute({ name, width, height, data, pbr_channel, fill_color, group, render_mode, render_sides }) {
      requireTextureProject(false);
      const textureGroup = group ? findTextureGroupOrThrow(group) : undefined;
      if (textureGroup?.is_material) requireTextureProject();
      if (pbr_channel && !textureGroup?.is_material) throw new Error("pbr_channel requires a PBR material group. Use create_pbr_material first.");
      const project = Project;
      let texture = new Texture({ name, width, height, internal: true });
      if (data && !data.startsWith("data:image/")) {
        if (Blockbench.isWeb) throw new Error("File paths require Blockbench desktop. Pass an image data URL instead.");
        const fs = requireNativeModule("fs");
        if (!fs) throw new Error("Local file access is unavailable.");
        const path = data.replace(/^file:\/\//, "");
        if (!fs.existsSync(path) || !fs.statSync(path).isFile()) throw new Error(`Texture file not found: ${path}`);
        texture = await stageImportedImage(path, pbr_channel ?? "color", fs);
        if (Texture.all.includes(texture)) throw new Error("This image path is already loaded. Use the existing texture with assign_texture_channel or add_texture_group.");
      }
      if (data?.startsWith("data:image/")) {
        texture.fromDataURL(data);
        try {
          await texture.img.decode();
        } catch {
          throw new Error("Cannot decode texture data URL. Provide valid image data.");
        }
      }
      if (!data) {
        const { ctx } = texture.getActiveCanvas();
        if (fill_color) {
          const parseColor = Reflect.get(globalThis, "tinycolor") as (value: string | { r: number; g: number; b: number; a: number }) => { toRgbString: () => string };
          const color = Array.isArray(fill_color)
            ? parseColor({ r: fill_color[0], g: fill_color[1], b: fill_color[2], a: (fill_color[3] ?? 255) / 255 })
            : parseColor(fill_color);
          ctx.fillStyle = color.toRgbString().toLowerCase();
          ctx.fillRect(0, 0, texture.width, texture.height);
        }
        if (!fill_color) ctx.clearRect(0, 0, texture.width, texture.height);
        texture.updateSource(ctx.canvas.toDataURL("image/png", 1));
        texture.updateLayerChanges(true);
      }
      if (Project !== project) throw new Error("The active project changed while loading the texture. Select the intended project and try again.");
      texture.name = name;
      texture.pbr_channel = pbr_channel ?? "color";
      texture.render_mode = render_mode;
      texture.render_sides = render_sides;
      texture.updateMaterial();
      const result = imageContent({ url: texture.getDataURL() });
      if (textureGroup) {
        const displaced = textureGroup.is_material ? textureGroup.getTextures()
          .filter(existing => existing.pbr_channel === texture.pbr_channel)
          .map(existing => ({ texture: existing, group: "", channel: pbrChannelEnum.parse(existing.pbr_channel) })) : [];
        const changes: TextureChange[] = [...displaced, { texture, group: textureGroup.uuid, channel: pbrChannelEnum.parse(texture.pbr_channel) }];
        commitMaterialEdit(textureGroup, changes, {}, "Agent created texture", [texture]);
        return result;
      }
      const created: Texture[] = [];
      Undo.initEdit({ textures: created, bitmap: true });
      try {
        created.push(texture);
        texture.add(false);
        Canvas.updateAll();
        Undo.finishEdit("Agent created texture");
      } catch (error) {
        (Undo.cancelEdit as (revertChanges?: boolean) => void)(true);
        throw error;
      }
      return result;
    },
  }, textureToolDocs[0].status);

  createTool(textureToolDocs[1].name, {
    ...textureToolDocs[1],
    async execute({ applyTo, id, texture }) {
      const element = findElementOrThrow(id);
      const projectTexture = texture
        ? findTextureOrThrow(texture)
        : Texture.getDefault();

      if (!projectTexture) {
        throw new Error(
          "No default texture available. Use the create_texture tool to create one first."
        );
      }

      // Resolve `id` to the concrete set of cubes/meshes to texture.
      // - Group → all descendant cubes + meshes
      // - Cube / Mesh → that single element
      const targets: Array<Cube | Mesh> = [];
      if (element instanceof Group) {
        const collectDescendants = (group: Group) => {
          for (const child of group.children ?? []) {
            if (child instanceof Cube || child instanceof Mesh) {
              targets.push(child);
              continue;
            }
            if (child instanceof Group) collectDescendants(child);
          }
        };
        collectDescendants(element);
      } else if (element instanceof Cube || element instanceof Mesh) {
        targets.push(element);
      } else {
        throw new Error(
          `Element "${id}" is not a cube, mesh, or group — cannot apply texture to it.`
        );
      }

      if (targets.length === 0) {
        throw new Error(
          `Element "${id}" resolved to no paintable cubes or meshes.`
        );
      }

      // Save prior selection so the call is non-destructive to UI state.
      const prevCubeSelection = [...Cube.selected];
      const prevMeshSelection = [...Mesh.selected];
      const prevGroup = Group.selected ?? null;

      // Undo must capture the element face-texture state, not just outliner.
      Undo.initEdit({
        elements: targets,
        outliner: false,
        collections: [],
      });

      try {
        // Replace selection with the resolved targets so Texture.apply()
        // operates on exactly this scope.
        Cube.all.forEach((c: Cube) => {
          if (c.selected) c.unselect?.();
        });
        Mesh.all.forEach((m: Mesh) => {
          if (m.selected) m.unselect?.();
        });
        for (const target of targets) {
          // @ts-ignore - select method available on outliner elements
          target.select?.({ shiftKey: true });
        }
        updateSelection();

        projectTexture.select();

        Texture.selected?.apply(
          applyTo === "none" ? false : applyTo === "all" ? true : "blank"
        );

        projectTexture.updateChangesAfterEdit();
      } finally {
        // Restore the caller's original selection.
        Cube.all.forEach((c: Cube) => {
          if (c.selected) c.unselect?.();
        });
        Mesh.all.forEach((m: Mesh) => {
          if (m.selected) m.unselect?.();
        });
        for (const c of prevCubeSelection) {
          // @ts-ignore - select method
          c.select?.({ shiftKey: true });
        }
        for (const m of prevMeshSelection) {
          // @ts-ignore - select method
          m.select?.({ shiftKey: true });
        }
        if (prevGroup) prevGroup.selected = true;
        updateSelection();
      }

      Undo.finishEdit("Agent applied texture");

      // Force face-level render refresh so the viewport matches the data.
      // Canvas.updateAll() alone sometimes doesn't push new face materials
      // into the THREE.js render targets.
      Canvas.updateView({
        elements: targets,
        element_aspects: { faces: true, uv: true, geometry: false },
      });
      Canvas.updateAll();

      return `Applied texture "${projectTexture.name}" to ${targets.length} element(s) scoped by "${id}" (${element instanceof Group ? "group" : element instanceof Cube ? "cube" : "mesh"}).`;
    },
  }, textureToolDocs[1].status);

  createTool(textureToolDocs[2].name, {
    ...textureToolDocs[2],
    parameters: addTextureGroupParameters,
    async execute({ name, textures, is_material }) {
      requireTextureProject(is_material);
      const textureList = uniqueTextures((textures ?? []).map(findTextureOrThrow));
      const textureGroup = new TextureGroup({
        name,
        is_material,
      });
      const changes = textureList.map(texture => ({ texture, group: textureGroup.uuid, channel: pbrChannelEnum.parse(texture.pbr_channel) }));
      commitMaterialEdit(textureGroup, changes, {}, "Agent added texture group");
      return `Added texture group ${textureGroup.name} with ID ${textureGroup.uuid}`;
    },
  }, textureToolDocs[2].status);

  createTool(textureToolDocs[3].name, {
    ...textureToolDocs[3],
    async execute() {
      const textures = Project?.textures ?? Texture.all;

      return JSON.stringify(
        textures.map((texture) => ({
          name: texture.name,
          uuid: texture.uuid,
          id: texture.id,
          group: texture.group,
        }))
      );
    },
  }, textureToolDocs[3].status);

  createTool(textureToolDocs[4].name, {
    ...textureToolDocs[4],
    async execute({ texture }) {
      if (!texture) {
        const defaultTexture = Texture.getDefault();
        if (!defaultTexture) {
          throw new Error(
            "No default texture available. Use the create_texture tool to create one first, or specify a texture ID."
          );
        }
        return imageContent({ url: defaultTexture.getDataURL() });
      }

      const image = findTextureOrThrow(texture);
      return imageContent({ url: image.getDataURL() });
    },
  }, textureToolDocs[4].status);

  createTool(textureToolDocs[5].name, {
    ...textureToolDocs[5],
    parameters: createPbrMaterialParameters,
    async execute(args) {
      requireTextureProject();
      const textureGroup = new TextureGroup({ name: args.name, is_material: true });
      const changes = planChannels(textureGroup, args);
      commitMaterialEdit(textureGroup, changes, args, "Agent created PBR material");
      const channels = projectedChannels(textureGroup, []);
      return JSON.stringify({
        success: true,
        material: {
          name: textureGroup.name,
          uuid: textureGroup.uuid,
          is_material: true,
          channels: {
            color: true,
            normal: channels.includes("normal"),
            height: channels.includes("height"),
            mer: true,
          },
        },
      });
    },
  }, textureToolDocs[5].status);

  createTool(textureToolDocs[6].name, {
    ...textureToolDocs[6],
    parameters: configureMaterialParameters,
    async execute(args) {
      const textureGroup = findMaterial(args.material);
      if (Object.entries(args).every(([key, value]) => key === "material" || value === undefined)) {
        throw new Error("Provide a channel assignment or a uniform material value to configure.");
      }
      const changes = planChannels(textureGroup, args);
      commitMaterialEdit(textureGroup, changes, args, "Agent configured material");
      return `Configured material "${textureGroup.name}"`;
    },
  }, textureToolDocs[6].status);

  createTool(textureToolDocs[7].name, {
    ...textureToolDocs[7],
    async execute() {
      // @ts-ignore - TextureGroup is globally available
      const materials = TextureGroup.all.filter(
        (g: TextureGroup) => g.is_material
      );

      const result = materials.map((group: TextureGroup) => {
        const textures = group.getTextures();
        return {
          name: group.name,
          uuid: group.uuid,
          channels: {
            color: getChannelTextureInfo(textures, "color"),
            normal: getChannelTextureInfo(textures, "normal"),
            height: getChannelTextureInfo(textures, "height"),
            mer: getChannelTextureInfo(textures, "mer"),
          },
          config: {
            color_value: group.material_config.color_value,
            mer_value: group.material_config.mer_value,
            subsurface_value: materialConfig(group).subsurface_value,
            saved: group.material_config.saved,
          },
        };
      });

      return JSON.stringify(result, null, 2);
    },
  }, textureToolDocs[7].status);

  createTool(textureToolDocs[8].name, {
    ...textureToolDocs[8],
    async execute({ material }) {
      const textureGroup = findTextureGroupOrThrow(material);
      const textures = textureGroup.getTextures();

      // Get compiled texture_set.json
      let textureSetJson = null;
      try {
        textureSetJson = textureGroup.material_config.compileForBedrock();
      } catch {
        // Format might not support texture_set.json
      }

      const result = {
        name: textureGroup.name,
        uuid: textureGroup.uuid,
        is_material: textureGroup.is_material,
        textures: textures.map((tex: Texture) => ({
          name: tex.name,
          uuid: tex.uuid,
          pbr_channel: tex.pbr_channel,
          width: tex.width,
          height: tex.height,
          render_mode: tex.render_mode,
          render_sides: tex.render_sides,
        })),
        config: {
          color_value: textureGroup.material_config.color_value,
          mer_value: textureGroup.material_config.mer_value,
          subsurface_value: materialConfig(textureGroup).subsurface_value,
          saved: textureGroup.material_config.saved,
          file_path: textureGroup.material_config.getFilePath(),
        },
        texture_set_json: textureSetJson,
      };

      return JSON.stringify(result, null, 2);
    },
  }, textureToolDocs[8].status);

  createTool(textureToolDocs[9].name, {
    ...textureToolDocs[9],
    parameters: importTextureSetParameters,
    async execute({ path }) {
      const material = await importMaterial(path);
      return JSON.stringify({ success: true, material: { name: material.name, uuid: material.uuid }, path });
    },
  }, textureToolDocs[9].status);

  createTool(textureToolDocs[10].name, {
    ...textureToolDocs[10],
    parameters: assignTextureChannelParameters,
    async execute({ material, texture, channel }) {
      const textureGroup = findMaterial(material);
      const channels: MaterialChannels = { [`${channel}_texture`]: texture };
      const changes = planChannels(textureGroup, channels);
      commitMaterialEdit(textureGroup, changes, {}, "Agent assigned texture channel");
      return `Assigned texture "${texture}" to ${channel} channel of material "${textureGroup.name}"`;
    },
  }, textureToolDocs[10].status);

  createTool(textureToolDocs[11].name, {
    ...textureToolDocs[11],
    parameters: saveMaterialConfigParameters,
    async execute({ material }) {
      const textureGroup = findMaterial(material);
      if (Blockbench.isWeb) throw new Error("save_material_config requires Blockbench desktop to save to the texture's file path.");
      validateMaterialChanges(textureGroup, []);
      const colorTexture = textureGroup.getTextures().find(texture => texture.pbr_channel === "color");
      const filePath = textureGroup.material_config.getFilePath();

      if (!colorTexture?.path || !filePath) {
        throw new Error(
          "Cannot save: Material needs a color texture with a valid file path. Save the color texture first, then try again."
        );
      }
      const fs = requireNativeModule("fs");
      if (!fs) throw new Error("Local file access is unavailable. Enable the plugin's file access before saving a material.");
      const pathModule = requireNativeModule("path");
      if (!fs.existsSync(pathModule.dirname(filePath))) throw new Error(`Cannot save material: output directory does not exist for "${filePath}".`);
      textureGroup.material_config.save();
      if (!fs.existsSync(filePath)) throw new Error(`Material config was not saved to "${filePath}".`);
      return `Saved material config to "${filePath}"`;
    },
  }, textureToolDocs[11].status);

  createTool(textureToolDocs[12].name, {
    ...textureToolDocs[12],
    async execute({ texture }) {
      const target = findTextureOrThrow(texture);
      if (Texture.selected?.uuid !== target.uuid) {
        target.select();
      }
      return `Activated texture "${target.name}" (uuid: ${target.uuid}). Paint tools will now target it by default.`;
    },
  }, textureToolDocs[12].status);
}
