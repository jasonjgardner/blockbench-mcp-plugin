/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import {
  getProjectTexture,
  imageContent,
  findElementOrThrow,
  findTextureOrThrow,
  findTextureGroupOrThrow,
  getChannelTextureInfo,
} from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import {
  colorSchema,
  elementIdSchema,
  textureIdSchema,
  textureIdOptionalSchema,
  pbrChannelEnum,
  renderModeEnum,
  renderSidesEnum,
} from "@/lib/zodObjects";

export function registerTextureTools() {
createTool(
  "create_texture",
  {
    description: "Creates a new texture with the given name and size.",
    annotations: {
      title: "Create Texture",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z
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
      ),
    async execute({
      name,
      width,
      height,
      data,
      pbr_channel,
      fill_color,
      group,
      layer_name,
    }) {
      Undo.initEdit({
        textures: [],
        collections: [],
      });

      let texture = new Texture({
        name,
        width,
        height,
        group,
        pbr_channel,
        internal: true,
      });

      if (data) {
        if (data.startsWith("data:image/")) {
          texture.source = data;
          texture.width = width;
          texture.height = height;
        } else {
          texture = texture.fromFile({
            name: data.split(/[\/\\]/).pop() || data,
            path: data.replace(/^file:\/\//, ""),
          });
        }

        texture.load();
        texture.fillParticle();
        texture.layers_enabled = false;
      } else {
        const { ctx } = texture.getActiveCanvas();

        if (fill_color) {
          const color = Array.isArray(fill_color)
            // @ts-ignore - tinycolor is available globally in Blockbench
            ? tinycolor({
              r: Number(fill_color[0]),
              g: Number(fill_color[1]),
              b: Number(fill_color[2]),
              a: Number(fill_color[3] ?? 255),
            })
            // @ts-ignore - tinycolor ok
            : tinycolor(fill_color);

          ctx.fillStyle = color.toRgbString().toLowerCase();
          ctx.fillRect(0, 0, texture.width, texture.height);
        } else {
          ctx.clearRect(0, 0, texture.width, texture.height);
        }

        texture.updateSource(ctx.canvas.toDataURL("image/png", 1));
        texture.updateLayerChanges(true);
      }

      texture.add();

      Undo.finishEdit("Agent created texture");
      Canvas.updateAll();

      return imageContent({
        url: texture.getDataURL(),
      });
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "apply_texture",
  {
    description:
      "Applies the given texture to the element with the specified ID.",
    annotations: {
      title: "Apply Texture",
      destructiveHint: true,
    },
    parameters: z.object({
      id: elementIdSchema.describe("ID or name of the element to apply the texture to."),
      texture: textureIdSchema.describe("ID or name of the texture to apply."),
      applyTo: z
        .enum(["all", "blank", "none"])
        .describe("Apply texture to element or group.")
        .optional()
        .default("blank"),
    }),
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

      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
      });

      projectTexture.select();

      Texture.selected?.apply(
        applyTo === "none" ? false : applyTo === "all" ? true : "blank"
      );

      projectTexture.updateChangesAfterEdit();

      Undo.finishEdit("Agent applied texture");
      Canvas.updateAll();

      return `Applied texture ${projectTexture.name} to element with ID ${id}`;
    },
  },
  STATUS_STABLE
);

createTool(
  "add_texture_group",
  {
    description: "Adds a new texture group with the given name.",
    annotations: {
      title: "Add Texture Group",
      destructiveHint: true,
    },
    parameters: z.object({
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
    }),
    async execute({ name, textures, is_material }) {
      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
        textures: [],
      });

      const textureGroup = new TextureGroup({
        name,
        is_material,
      }).add();

      if (textures) {
        const textureList = textures
          .map((texture) => getProjectTexture(texture))
          .filter(Boolean);

        if (textureList.length === 0) {
          throw new Error(`No textures found for "${textures}".`);
        }

        textureList.forEach((texture) => {
          texture?.extend({
            group: textureGroup.uuid,
          });
        });
      }

      Undo.finishEdit("Agent added texture group");
      Canvas.updateAll();

      return `Added texture group ${textureGroup.name} with ID ${textureGroup.uuid}`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "list_textures",
  {
    description: "Returns a list of all textures in the Blockbench editor.",
    annotations: {
      title: "List Textures",
      readOnlyHint: true,
    },
    parameters: z.object({}),
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
  },
  STATUS_STABLE
);

createTool(
  "get_texture",
  {
    description:
      "Returns the image data of the given texture or default texture.",
    annotations: {
      title: "Get Texture",
      readOnlyHint: true,
    },
    parameters: z.object({
      texture: textureIdOptionalSchema,
    }),
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
  },
  STATUS_STABLE
);

createTool(
  "create_pbr_material",
  {
    description:
      "Creates a new PBR material (texture group with is_material=true) and optionally assigns textures to PBR channels. Use this for Minecraft Bedrock resource packs or any format supporting PBR.",
    annotations: {
      title: "Create PBR Material",
      destructiveHint: true,
    },
    parameters: z.object({
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
        .array(z.number().min(0).max(255))
        .length(4)
        .optional()
        .describe(
          "Uniform RGBA color [R,G,B,A] when no color texture is provided."
        ),
      mer_value: z
        .array(z.number().min(0).max(255))
        .length(3)
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
    }),
    async execute({
      name,
      color_texture,
      normal_texture,
      height_texture,
      mer_texture,
      color_value,
      mer_value,
      subsurface_value,
    }) {
      const texturesToAdd: Texture[] = [];

      // Find textures to add
      if (color_texture) {
        const tex = findTextureOrThrow(color_texture);
        texturesToAdd.push(tex);
      }
      if (normal_texture) {
        const tex = findTextureOrThrow(normal_texture);
        texturesToAdd.push(tex);
      }
      if (height_texture) {
        const tex = findTextureOrThrow(height_texture);
        texturesToAdd.push(tex);
      }
      if (mer_texture) {
        const tex = findTextureOrThrow(mer_texture);
        texturesToAdd.push(tex);
      }

      Undo.initEdit({
        texture_groups: [],
        textures: texturesToAdd,
      });

      // @ts-ignore - TextureGroup is globally available
      const textureGroup = new TextureGroup({
        name,
        is_material: true,
      });

      // Set material config values
      if (color_value) {
        textureGroup.material_config.color_value = color_value;
      }
      if (mer_value) {
        textureGroup.material_config.mer_value = mer_value;
      }
      if (subsurface_value !== undefined) {
        textureGroup.material_config.subsurface_value = subsurface_value;
      }
      textureGroup.material_config.saved = false;

      textureGroup.add();

      // Assign textures to channels
      if (color_texture) {
        const tex = findTextureOrThrow(color_texture);
        tex.extend({ group: textureGroup.uuid, pbr_channel: "color" });
      }
      if (normal_texture) {
        const tex = findTextureOrThrow(normal_texture);
        tex.extend({ group: textureGroup.uuid, pbr_channel: "normal" });
      }
      if (height_texture) {
        const tex = findTextureOrThrow(height_texture);
        tex.extend({ group: textureGroup.uuid, pbr_channel: "height" });
      }
      if (mer_texture) {
        const tex = findTextureOrThrow(mer_texture);
        tex.extend({ group: textureGroup.uuid, pbr_channel: "mer" });
      }

      // Update material preview
      textureGroup.updateMaterial();

      Undo.finishEdit("Agent created PBR material");
      Canvas.updateAll();

      return JSON.stringify({
        success: true,
        material: {
          name: textureGroup.name,
          uuid: textureGroup.uuid,
          is_material: true,
          channels: {
            color: color_texture ? true : !!color_value,
            normal: !!normal_texture,
            height: !!height_texture,
            mer: mer_texture ? true : !!mer_value,
          },
        },
      });
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "configure_material",
  {
    description:
      "Configures an existing PBR material's properties including channel assignments, uniform values, and subsurface scattering.",
    annotations: {
      title: "Configure Material",
      destructiveHint: true,
    },
    parameters: z.object({
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
        .array(z.number().min(0).max(255))
        .length(4)
        .optional()
        .describe("Uniform RGBA color [R,G,B,A] when no color texture."),
      mer_value: z
        .array(z.number().min(0).max(255))
        .length(3)
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
    }),
    async execute({
      material,
      color_texture,
      normal_texture,
      height_texture,
      mer_texture,
      color_value,
      mer_value,
      subsurface_value,
    }) {
      const textureGroup = findTextureGroupOrThrow(material);
      const textures = textureGroup.getTextures();

      Undo.initEdit({
        texture_groups: [textureGroup],
        textures,
      });

      // Handle color channel
      if (color_texture === "none") {
        textures
          .filter((t: Texture) => t.pbr_channel === "color")
          .forEach((t: Texture) => (t.group = ""));
      } else if (color_texture) {
        textures
          .filter((t: Texture) => t.pbr_channel === "color")
          .forEach((t: Texture) => (t.pbr_channel = "color"));
        const tex = findTextureOrThrow(color_texture);
        tex.extend({ group: textureGroup.uuid, pbr_channel: "color" });
      }

      // Handle normal channel
      if (normal_texture === "none") {
        textures
          .filter((t: Texture) => t.pbr_channel === "normal")
          .forEach((t: Texture) => (t.group = ""));
      } else if (normal_texture) {
        const tex = findTextureOrThrow(normal_texture);
        tex.extend({ group: textureGroup.uuid, pbr_channel: "normal" });
      }

      // Handle height channel
      if (height_texture === "none") {
        textures
          .filter((t: Texture) => t.pbr_channel === "height")
          .forEach((t: Texture) => (t.group = ""));
      } else if (height_texture) {
        const tex = findTextureOrThrow(height_texture);
        tex.extend({ group: textureGroup.uuid, pbr_channel: "height" });
      }

      // Handle MER channel
      if (mer_texture === "none") {
        textures
          .filter((t: Texture) => t.pbr_channel === "mer")
          .forEach((t: Texture) => (t.group = ""));
      } else if (mer_texture) {
        const tex = findTextureOrThrow(mer_texture);
        tex.extend({ group: textureGroup.uuid, pbr_channel: "mer" });
      }

      // Update uniform values
      if (color_value) {
        textureGroup.material_config.color_value = color_value;
      }
      if (mer_value) {
        textureGroup.material_config.mer_value = mer_value;
      }
      if (subsurface_value !== undefined) {
        textureGroup.material_config.subsurface_value = subsurface_value;
      }

      textureGroup.material_config.saved = false;
      textureGroup.updateMaterial();

      Undo.finishEdit("Agent configured material");
      Canvas.updateAll();

      return `Configured material "${textureGroup.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "list_materials",
  {
    description:
      "Lists all PBR materials (texture groups with is_material=true) and their assigned textures per channel.",
    annotations: {
      title: "List Materials",
      readOnlyHint: true,
    },
    parameters: z.object({}),
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
            subsurface_value: group.material_config.subsurface_value,
            saved: group.material_config.saved,
          },
        };
      });

      return JSON.stringify(result, null, 2);
    },
  },
  STATUS_STABLE
);

createTool(
  "get_material_info",
  {
    description:
      "Gets detailed information about a PBR material including the compiled texture_set.json preview for Bedrock export.",
    annotations: {
      title: "Get Material Info",
      readOnlyHint: true,
    },
    parameters: z.object({
      material: z.string().describe("Material name or UUID."),
    }),
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
          subsurface_value: textureGroup.material_config.subsurface_value,
          saved: textureGroup.material_config.saved,
          file_path: textureGroup.material_config.getFilePath(),
        },
        texture_set_json: textureSetJson,
      };

      return JSON.stringify(result, null, 2);
    },
  },
  STATUS_STABLE
);

createTool(
  "import_texture_set",
  {
    description:
      "Imports a Minecraft Bedrock texture_set.json file and creates a PBR material with the associated textures.",
    annotations: {
      title: "Import Texture Set",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      path: z
        .string()
        .describe(
          "Path to the .texture_set.json file to import."
        ),
    }),
    async execute({ path }) {
      // Validate path ends with texture_set.json
      if (!path.endsWith(".texture_set.json")) {
        throw new Error(
          "Path must end with '.texture_set.json'. Example: 'path/to/mytexture.texture_set.json'"
        );
      }

      // @ts-ignore - fs module available via Blockbench
      const fs = requireNativeModule("fs");
      if (!fs.existsSync(path)) {
        throw new Error(`File not found: ${path}`);
      }

      // Use Blockbench's importTextureSet function
      // @ts-ignore - importTextureSet is globally available
      importTextureSet({ path, name: path.split(/[\/\\]/).pop() });

      return `Imported texture set from "${path}". Check the textures panel for the new material.`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "assign_texture_channel",
  {
    description:
      "Assigns a texture to a specific PBR channel within a material.",
    annotations: {
      title: "Assign Texture Channel",
      destructiveHint: true,
    },
    parameters: z.object({
      material: z.string().describe("Material name or UUID."),
      texture: textureIdSchema.describe("Texture name or UUID to assign."),
      channel: pbrChannelEnum.describe("PBR channel to assign the texture to."),
    }),
    async execute({ material, texture, channel }) {
      const textureGroup = findTextureGroupOrThrow(material);
      const tex = findTextureOrThrow(texture);

      Undo.initEdit({
        texture_groups: [textureGroup],
        textures: [tex],
      });

      // Remove any existing texture from this channel in the group
      const existingTextures = textureGroup.getTextures();
      existingTextures
        .filter((t: Texture) => t.pbr_channel === channel && t.uuid !== tex.uuid)
        .forEach((t: Texture) => {
          t.pbr_channel = "color"; // Reset to color
        });

      // Assign the texture to the channel
      tex.extend({
        group: textureGroup.uuid,
        pbr_channel: channel,
      });

      textureGroup.material_config.saved = false;
      textureGroup.updateMaterial();

      Undo.finishEdit("Agent assigned texture channel");
      Canvas.updateAll();

      return `Assigned texture "${tex.name}" to ${channel} channel of material "${textureGroup.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "save_material_config",
  {
    description:
      "Saves the material's texture_set.json file to disk (Bedrock format). Requires the color texture to have a valid file path.",
    annotations: {
      title: "Save Material Config",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      material: z.string().describe("Material name or UUID to save."),
    }),
    async execute({ material }) {
      const textureGroup = findTextureGroupOrThrow(material);
      const filePath = textureGroup.material_config.getFilePath();

      if (!filePath) {
        throw new Error(
          "Cannot save: Material needs a color texture with a valid file path. Save the color texture first, then try again."
        );
      }

      textureGroup.material_config.save();

      return `Saved material config to "${filePath}"`;
    },
  },
  STATUS_EXPERIMENTAL
);
}
