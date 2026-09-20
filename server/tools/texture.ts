/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import {
  imageContent,
  findElementOrThrow,
  findTextureOrThrow,
  findTextureGroupOrThrow,
  getChannelTextureInfo,
} from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { createJsonResult } from "@/lib/tool-results";
import { runUndoableEdit } from "@/lib/undo";
import {
  colorByte,
  colorSchema,
  elementIdSchema,
  textureIdSchema,
  textureIdOptionalSchema,
  pbrChannelEnum,
  renderModeEnum,
  renderSidesEnum,
  rgbByteTuple,
  rgbaByteTuple,
} from "@/lib/zodObjects";
import {
  applyTextureToTargets,
  describeTargetKind,
  resolveTextureTargets,
} from "@/server/tools/texture/apply-texture";
import { addCreatedTexture, loadTextureData } from "@/server/tools/texture/create-texture";
import {
  commitMaterialEdit,
  findMaterial,
  materialConfig,
  planChannels,
  projectedChannels,
  requireTextureProject,
  uniqueByUuid,
  validateMaterialChanges,
  type MaterialChannels,
} from "@/server/tools/texture/material-edit";
import { importMaterial } from "@/server/tools/texture/texture-set-import";

// ============================================================================
// Texture Tool Parameter Schemas
// ============================================================================

/** Create a texture from pixels or a fill, with optional paired logical UV dimensions for per-texture formats; `pbr_channel` requires a material `group`. */
export const createTextureParameters = z
  .object({
    name: z.string(),
    width: z.number().min(16).max(4096).default(16),
    height: z.number().min(16).max(4096).default(16),
    uv_width: z.number().finite().positive().optional().describe("Logical UV width for formats with per_texture_uv_size. Supply uv_height too. Independent of bitmap width; omit both to preserve native defaults."),
    uv_height: z.number().finite().positive().optional().describe("Logical UV height for formats with per_texture_uv_size. Supply uv_width too. Independent of bitmap height."),
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
  .refine(params => (params.uv_width === undefined) === (params.uv_height === undefined), {
    message: "Supply both uv_width and uv_height, or omit both.",
    path: ["uv_width"],
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

/** Apply a texture to one cube/mesh or every cube/mesh inside a group, choosing which faces receive it. */
export const applyTextureParameters = z.object({
  id: elementIdSchema.describe("ID or name of the element to apply the texture to."),
  texture: textureIdSchema.describe("ID or name of the texture to apply."),
  applyTo: z
    .enum(["all", "blank", "none"])
    .describe("Apply texture to element or group.")
    .optional()
    .default("blank"),
});

/** Create a texture group (a PBR material by default) containing existing textures. */
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

/** list_textures takes no arguments. */
export const listTexturesParameters = z.object({});

/** Read a texture's image by ID or name; omit `texture` for the project's default texture. */
export const getTextureParameters = z.object({
  texture: textureIdOptionalSchema,
});

/** Select the texture that later paint tools target by default. */
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
  color_value: rgbaByteTuple()
    .optional()
    .describe(
      "Uniform RGBA color [R,G,B,A] when no color texture is provided."
    ),
  mer_value: rgbByteTuple()
    .optional()
    .describe(
      "Uniform MER values [Metalness, Emissive, Roughness] (0-255) when no MER texture is provided."
    ),
  subsurface_value: colorByte()
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
  color_value: rgbaByteTuple()
    .optional()
    .describe("Uniform RGBA color [R,G,B,A] when no color texture."),
  mer_value: rgbByteTuple()
    .optional()
    .describe(
      "Uniform MER values [Metalness, Emissive, Roughness] (0-255)."
    ),
  subsurface_value: colorByte()
    .optional()
    .describe("Subsurface scattering value (0-255)."),
}).refine(({ normal_texture, height_texture }) => !(normal_texture && normal_texture !== "none" && height_texture && height_texture !== "none"), {
  message: "Use either normal_texture or height_texture; set the other channel to 'none' when replacing it.",
  path: ["height_texture"],
});

/** list_materials takes no arguments. */
export const listMaterialsParameters = z.object({});

/** Inspect one PBR material by name or UUID. */
export const getMaterialInfoParameters = z.object({
  material: z.string().describe("Material name or UUID."),
});

/** Import a Bedrock `.texture_set.json` file from disk as a PBR material. */
export const importTextureSetParameters = z.object({
  path: z
    .string()
    .describe(
      "Path to the .texture_set.json file to import."
    ),
});

/** Move one texture into a material channel, detaching the previous map. */
export const assignTextureChannelParameters = z.object({
  material: z.string().describe("Material name or UUID."),
  texture: textureIdSchema.describe("Texture name or UUID to assign."),
  channel: pbrChannelEnum.describe("PBR channel to assign the texture to."),
});

/** Write a material's texture_set.json next to its color texture. */
export const saveMaterialConfigParameters = z.object({
  material: z.string().describe("Material name or UUID to save."),
});

/** Remove one texture from the project by ID, UUID, or name. */
export const deleteTextureParameters = z.object({
  texture: textureIdSchema.describe("Texture ID, UUID, or name to remove."),
});

// ============================================================================
// Texture Tool Docs
// ============================================================================

/**
 * Public specs for every texture and PBR material tool (name, description,
 * annotations, parameter schema, status). Shared by `registerTextureTools` and
 * the docs generator, so it must stay free of Blockbench runtime globals.
 * Registration indexes this array, so keep the order stable.
 */
export const textureToolDocs: IToolSpec[] = [
  {
    name: "create_texture",
    condition: { project: true },
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
    condition: { project: true, features: ["edit_mode"], method: () => Texture.all.length > 0 },
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
    condition: { project: true },
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
    condition: { project: true },
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
    condition: { project: true, method: () => Texture.all.length > 0 },
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
    condition: { project: true, features: ["pbr"] },
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
    condition: { project: true, features: ["pbr"] },
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
    condition: { project: true, features: ["pbr"] },
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
    condition: { project: true },
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
    condition: { project: true, features: ["pbr"], method: () => !Blockbench.isWeb },
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
    condition: { project: true, features: ["pbr"] },
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
    condition: { project: true, features: ["pbr"], method: () => !Blockbench.isWeb },
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
    condition: { project: true, method: () => Texture.all.length > 0 },
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
  {
    name: "delete_texture",
    condition: { project: true, method: () => Texture.all.length > 0 },
    description:
      "Removes a texture from the project in one undoable edit, like deleting it from the Textures panel. Faces keep their UV mapping but lose the texture assignment, and a PBR material loses that channel, until the edit is undone. Use list_textures to find IDs.",
    annotations: {
      title: "Delete Texture",
      destructiveHint: true,
    },
    parameters: deleteTextureParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

/**
 * Refreshes the scene after a texture leaves the project, mirroring the
 * native delete action in `js/texturing/textures.js`: faces re-render without
 * the texture, layered previews rebuild, and toolbars re-evaluate conditions.
 */
function refreshAfterTextureRemoval(): void {
  Canvas.updateAllFaces();
  if (Reflect.get(Canvas, "layered_material")) Canvas.updateLayeredTextures();
  TextureAnimator.updateButton();
  UVEditor.vue?.updateTexture();
  BARS.updateConditions();
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Registers texture editing and material tools with validated, reversible PBR changes.
 * Blockbench globals are only touched inside each tool's `execute`, so this
 * module stays importable by the docs generator outside Blockbench.
 */
export function registerTextureTools(): void {
  createTool(textureToolDocs[0].name, {
    ...textureToolDocs[0],
    parameters: createTextureParameters,
    async execute({ name, width, height, uv_width, uv_height, data, pbr_channel, fill_color, group, render_mode, render_sides }) {
      requireTextureProject(false);
      if (uv_width !== undefined && !Format.per_texture_uv_size) {
        throw new Error("The current format uses project-wide UV dimensions. Per-texture uv_width/uv_height would have no effect; edit project UV size through the native project workflow.");
      }
      const textureGroup = group ? findTextureGroupOrThrow(group) : undefined;
      if (textureGroup?.is_material) requireTextureProject();
      if (pbr_channel && !textureGroup?.is_material) {
        throw new Error("pbr_channel requires a PBR material group. Use create_pbr_material first.");
      }
      const project = Project;
      const blank = new Texture({ name, width, height, internal: true });
      const texture = await loadTextureData(blank, data, fill_color, pbr_channel ?? "color");
      if (Project !== project) {
        throw new Error("The active project changed while loading the texture. Select the intended project and try again.");
      }
      texture.name = name;
      texture.pbr_channel = pbr_channel ?? "color";
      texture.render_mode = render_mode;
      texture.render_sides = render_sides;
      if (uv_width !== undefined && uv_height !== undefined) {
        texture.uv_width = uv_width;
        texture.uv_height = uv_height;
      }
      texture.updateMaterial();
      const result = imageContent({ url: texture.getDataURL() });
      addCreatedTexture(texture, textureGroup);
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
      const targets = resolveTextureTargets(element, id);
      if (targets.length === 0) {
        throw new Error(
          `Element "${id}" resolved to no paintable cubes or meshes.`
        );
      }

      applyTextureToTargets(projectTexture, targets, applyTo);

      return `Applied texture "${projectTexture.name}" to ${targets.length} element(s) scoped by "${id}" (${describeTargetKind(element)}).`;
    },
  }, textureToolDocs[1].status);

  createTool(textureToolDocs[2].name, {
    ...textureToolDocs[2],
    parameters: addTextureGroupParameters,
    async execute({ name, textures, is_material }) {
      requireTextureProject(is_material);
      const textureList = uniqueByUuid((textures ?? []).map(findTextureOrThrow));
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
          uv_size: [texture.getUVWidth(), texture.getUVHeight()],
          bitmap_size: [texture.width, texture.height],
          frame_size: [texture.width, texture.display_height],
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

  createTool(textureToolDocs[13].name, {
    ...textureToolDocs[13],
    async execute({ texture }) {
      const target = findTextureOrThrow(texture);
      const removed = { name: target.name, uuid: target.uuid, id: target.id };
      // The transaction holds only the removal: Blockbench cannot revert a removed
      // object from a cancelled edit, so nothing that may throw belongs inside it.
      // `bitmap` keeps layered pixels for undo; the finish aspects list no texture
      // so the history entry records it as gone instead of resurrecting it on redo.
      runUndoableEdit(
        { textures: [target], bitmap: true, selected_texture: true },
        "Agent removed texture",
        () => target.remove(true),
        { textures: [], selected_texture: true },
      );
      refreshAfterTextureRemoval();
      return createJsonResult({ removed, remaining_textures: (Project?.textures ?? Texture.all).length });
    },
  }, textureToolDocs[13].status);
}
