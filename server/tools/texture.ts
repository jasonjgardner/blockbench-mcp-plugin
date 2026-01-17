/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import {
  getProjectTexture,
  imageContent,
  findElementOrThrow,
  findTextureOrThrow,
} from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";

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
        fill_color: z
          .union([
            z.array(z.number().min(0).max(255)).length(4).describe("RGBA color array [R, G, B, A]"),
            z
              .string()
              .regex(
                /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/,
                "HEX color string (e.g. #RRGGBB or #RRGGBBAA)"
              ),
            z
              .string()
              .regex(
                /^[a-z]{3,20}$/,
                "Color name (e.g. 'red', 'blue', 'green')"
              ),
          ])
          .optional()
          .describe("RGBA color to fill the texture, as tuple or HEX string."),
        layer_name: z
          .string()
          .optional()
          .describe(
            "Name of the texture layer. Required if fill_color is set."
          ),
        pbr_channel: z
          .enum(["color", "normal", "height", "mer"])
          .optional()
          .describe(
            "PBR channel to use for the texture. Color, normal, height, or Metalness/Emissive/Roughness (MER) map."
          ),
        render_mode: z
          .enum(["default", "emissive", "additive", "layered"])
          .optional()
          .default("default")
          .describe(
            "Render mode for the texture. Default, emissive, additive, or layered."
          ),
        render_sides: z
          .enum(["auto", "front", "double"])
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
      id: z
        .string()
        .describe("ID or name of the element to apply the texture to."),
      texture: z.string().describe("ID or name of the texture to apply."),
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
      texture: z.string().optional().describe("Texture ID or name."),
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
}
