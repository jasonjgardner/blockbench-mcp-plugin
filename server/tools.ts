/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import {
  getProjectTexture,
  captureScreenshot,
  captureAppScreenshot,
} from "@/lib/util";
import { imageContent } from "fastmcp";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";

import "./tools/animation";
import "./tools/cubes";
import "./tools/mesh";
import "./tools/uv";

createTool(
  "trigger_action",
  {
    description: "Triggers an action in the Blockbench editor.",
    annotations: {
      title: "Trigger Action",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      action: z
        .enum(Object.keys(BarItems) as [string, ...string[]])
        .describe("Action to trigger."),
      confirmDialog: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Whether or not to automatically confirm any dialogs that appear as a result of the action."
        ),
      confirmEvent: z
        .string()
        .optional()
        .describe("Stringified form of event arguments."),
    }),
    async execute({ action, confirmEvent: args, confirmDialog }) {
      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
      });
      const parsedArgs = args ? JSON.parse(args) : {};

      if (!(action in BarItems)) {
        throw new Error(`Action "${action}" not found.`);
      }
      const barItem = BarItems[action];

      if (barItem && barItem instanceof Action) {
        const { event, ...rest } = parsedArgs;
        barItem.trigger(
          new Event(event || "click", {
            ...rest,
          })
        );
      }

      if (confirmDialog) {
        Dialog.open?.confirm();
      }

      Undo.finishEdit("Agent triggered action");

      return await captureAppScreenshot();
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "risky_eval",
  {
    description:
      "Evaluates the given expression and logs it to the console. Do not pass `console` commands as they will not work.",
    annotations: {
      title: "Eval",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      code: z
        .string()
        .refine((val) => !/console\.|\/\/|\/\*/.test(val), {
          message:
            "Code must not include 'console.', '//' or '/* */' comments.",
        })
        .describe(
          "JavaScript code to evaluate. Do not pass `console` commands or comments."
        ),
    }),
    async execute({ code }) {
      try {
        Undo.initEdit({
          elements: [],
          outliner: true,
          collections: [],
        });

        const result = await eval(code.trim());

        if (result !== undefined) {
          return JSON.stringify(result);
        }

        return "(Code executed successfully, but no result was returned.)";
      } catch (error) {
        return `Error executing code: ${error}`;
      } finally {
        Undo.finishEdit("Agent executed code");
      }
    },
  },
  STATUS_STABLE
);

createTool(
  "emulate_clicks",
  {
    description: "Emulates clicks on the given interface elements.",
    annotations: {
      title: "Emulate Clicks",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      position: z.object({
        x: z.number(),
        y: z.number(),
        button: z
          .enum(["left", "right"])
          .optional()
          .default("left")
          .describe("Mouse button to use."),
      }),
      drag: z
        .object({
          to: z.object({
            x: z.number(),
            y: z.number(),
          }),
          duration: z
            .number()
            .optional()
            .default(100)
            .describe("Duration of the drag in milliseconds."),
        })
        .optional()
        .describe(
          "Drag options. If set, will perform a drag from position to 'to'."
        ),
    }),
    async execute({ position, drag }) {
      // Emulate a click at the specified position
      const { x, y, button } = position;
      const mouseEvent = new MouseEvent("click", {
        clientX: x,
        clientY: y,
        button: button === "left" ? 0 : 2,
      });
      document.dispatchEvent(mouseEvent);
      if (drag) {
        const { to, duration } = drag;
        const dragStartEvent = new MouseEvent("mousedown", {
          clientX: x,
          clientY: y,
          button: button === "left" ? 0 : 2,
        });
        const dragEndEvent = new MouseEvent("mouseup", {
          clientX: to.x,
          clientY: to.y,
          button: button === "left" ? 0 : 2,
        });
        document.dispatchEvent(dragStartEvent);
        await new Promise((resolve) => setTimeout(resolve, duration));
        document.dispatchEvent(dragEndEvent);
      }

      // Capture a screenshot after the click
      return await captureAppScreenshot();
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "fill_dialog",
  {
    description: "Fills the dialog with the given values.",
    annotations: {
      title: "Fill Dialog",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      values: z
        .string()
        .describe("Stringified form of values to fill the dialog with."),
      confirm: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Whether to confirm or cancel the dialog after filling it. True to confirm, false to cancel."
        ),
    }),
    async execute({ values, confirm }) {
      if (!Dialog.stack.length) {
        throw new Error("No dialogs found in the Blockbench editor.");
      }
      if (!Dialog.open) {
        Dialog.stack[Dialog.stack.length - 1]?.focus();
      }
      const parsedValues = JSON.parse(values);

      const keys = Object.keys(Dialog.open?.getFormResult() ?? {});
      const valuesToFill = Object.entries(parsedValues).reduce(
        (acc, [key, value]) => {
          if (keys.includes(key)) {
            acc[key as keyof FormResultValue] = value as FormResultValue;
          }
          return acc;
        }
      ) as Record<keyof FormResultValue, FormResultValue>;
      Dialog.open?.setFormValues(valuesToFill, true);

      if (confirm) {
        Dialog.open?.confirm();
      } else {
        Dialog.open?.cancel();
      }

      return JSON.stringify({
        result: `Current dialog stack is now ${Dialog.stack.length} deep.`,
        dialogs: Dialog.stack.map((d) => ({
          id: d.id,
          values: d.getFormResult(),
        })),
      });
    },
  },
  STATUS_EXPERIMENTAL
);

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
      } else if (fill_color) {
        const color = Array.isArray(fill_color)
          ? tinycolor({
            r: Number(fill_color[0]),
            g: Number(fill_color[1]),
            b: Number(fill_color[2]),
            a: Number(fill_color[3] ?? 255),
          })
          : tinycolor(fill_color);
        const { ctx } = texture.getActiveCanvas();

        ctx.fillStyle = color.toRgbString().toLowerCase();
        ctx.fillRect(0, 0, texture.width, texture.height);

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
    async execute({ applyTo, id }) {
      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
      });

      const element = Outliner.root.find(
        (el) => el.uuid === id || el.name === id
      );

      if (!element) {
        throw new Error(`Element with ID "${id}" not found.`);
      }

      const projectTexture = getProjectTexture(id) ?? Texture.getDefault();

      if (!projectTexture) {
        throw new Error(`Texture with ID "${id}" not found.`);
      }

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
  "remove_element",
  {
    description: "Removes the element with the given ID.",
    annotations: {
      title: "Remove Element",
      destructiveHint: true,
    },
    parameters: z.object({
      id: z.string().describe("ID or name of the element to remove."),
    }),
    async execute({ id }) {
      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
      });

      const element = Outliner.root.find(
        (el) => el.uuid === id || el.name === id
      );

      if (!element) {
        throw new Error(`Element with ID "${id}" not found.`);
      }

      element.remove();

      Undo.finishEdit("Agent removed element");
      Canvas.updateAll();

      return `Removed element with ID ${id}`;
    },
  },
  STATUS_EXPERIMENTAL
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
            group: textureGroup,
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
  "add_group",
  {
    description: "Adds a new group with the given name and options.",
    annotations: {
      title: "Add Group",
      destructiveHint: true,
    },
    parameters: z.object({
      name: z.string(),
      origin: z.array(z.number()).length(3),
      rotation: z.array(z.number()).length(3),
      parent: z.string().optional().default("root"),
      visibility: z.boolean().optional().default(true),
      autouv: z
        .enum(["0", "1", "2"])
        .optional()
        .default("0")
        .describe(
          "Auto UV setting. 0 = disabled, 1 = enabled, 2 = relative auto UV."
        ),
      selected: z.boolean().optional().default(false),
      shade: z.boolean().optional().default(false),
    }),
    async execute({
      name,
      origin,
      rotation,
      parent,
      visibility,
      autouv,
      selected,
      shade,
    }) {
      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
      });

      const group = new Group({
        name,
        origin,
        rotation,
        autouv: Number(autouv) as 0 | 1 | 2,
        visibility: Boolean(visibility),
        selected: Boolean(selected),
        shade: Boolean(shade),
      }).init();

      group.addTo(
        getAllGroups().find((g) => g.name === parent || g.uuid === parent)
      );

      Undo.finishEdit("Agent added group");
      Canvas.updateAll();

      return `Added group ${group.name} with ID ${group.uuid}`;
    },
  },
  STATUS_STABLE
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
  "create_project",
  {
    description: "Creates a new project with the given name and project type.",
    annotations: {
      title: "Create Project",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      name: z.string(),
      format: z
        .enum(Object.keys(Formats) as [string, ...string[]])
        .default("bedrock_block"),
    }),
    async execute({ name, format }) {
      const created = newProject(Formats[format]);

      if (!created) {
        throw new Error("Failed to create project.");
      }

      Project!.name = name;

      return `Created project with name "${name}" (UUID: ${Project?.uuid}) and format "${format}".`;
    },
  },
  STATUS_STABLE
);

createTool(
  "list_outline",
  {
    description:
      "Returns a list of all groups and their children in the Blockbench editor.",
    annotations: {
      title: "List Outline",
      readOnlyHint: true,
    },
    parameters: z.object({}),
    async execute() {
      const elements = Outliner.elements;

      return JSON.stringify(
        elements.map((element) => {
          const { name, uuid } = element;
          return {
            name,
            uuid,
          };
        }),
        null,
        2
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
        return imageContent({ url: Texture.getDefault().getDataURL() });
      }

      const image = getProjectTexture(texture);

      if (!image) {
        throw new Error(`Texture with ID "${texture}" not found.`);
      }

      return imageContent({ url: image.getDataURL() });
    },
  },
  STATUS_STABLE
);

createTool(
  "capture_screenshot",
  {
    description: "Returns the image data of the current view.",
    annotations: {
      title: "Capture Screenshot",
      readOnlyHint: true,
      destructiveHint: true,
    },
    parameters: z.object({
      project: z.string().optional().describe("Project name or UUID."),
    }),
    async execute({ project }) {
      return captureScreenshot(project);
    },
  },
  STATUS_STABLE
);

createTool(
  "capture_app_screenshot",
  {
    description: "Returns the image data of the Blockbench app.",
    annotations: {
      title: "Capture App Screenshot",
      readOnlyHint: true,
    },
    parameters: z.object({}),
    async execute() {
      return captureAppScreenshot();
    },
  },
  STATUS_STABLE
);

createTool(
  "set_camera_angle",
  {
    description: "Sets the camera angle to the specified value.",
    annotations: {
      title: "Set Camera Angle",
      destructiveHint: true,
    },
    parameters: z.object({
      angle: z.object({
        position: z
          .array(z.number())
          .length(3)
          .describe("Camera position."),
        target: z
          .array(z.number())
          .length(3)
          .optional()
          .describe("Camera target position."),
        rotation: z
          .array(z.number())
          .length(3)
          .optional()
          .describe("Camera rotation."),
        projection: z
          .enum(["unset", "orthographic", "perspective"])
          .describe("Camera projection type."),
      }),
    }),
    async execute({ angle }) {
      const preview = Preview.selected;

      if (!preview) {
        throw new Error("No preview found in the Blockbench editor.");
      }

      preview.loadAnglePreset(angle);

      return await captureScreenshot();
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "from_geo_json",
  {
    description: "Imports a model from a GeoJSON file.",
    annotations: {
      title: "Import GeoJSON",
      destructiveHint: true,
    },
    parameters: z.object({
      geojson: z
        .string()
        .describe(
          "Path to the GeoJSON file or data URL, or the GeoJSON string itself."
        ),
    }),
    async execute({ geojson }) {
      // Detect if the input is a URL or a string
      if (!geojson.startsWith("{") && !geojson.startsWith("[")) {
        // Assume it's a URL or file path
        geojson = await fetch(geojson).then((res) => res.text());
      }
      // Parse the GeoJSON string
      if (typeof geojson !== "string") {
        throw new Error("Invalid GeoJSON input. Expected a string.");
      }

      Codecs.bedrock.parse!(JSON.parse(geojson), "");

      return new Promise((resolve) => {
        setTimeout(async () => {
          resolve(await captureAppScreenshot());
        }, 3000);
      });
    },
  },
  STATUS_STABLE
);

createTool(
  "knife_tool",
  {
    description: "Uses the knife tool to cut custom edges into mesh faces.",
    annotations: {
      title: "Knife Tool",
      destructiveHint: true,
    },
    parameters: z.object({
      mesh_id: z.string().describe("ID or name of the mesh to cut."),
      points: z
        .array(
          z.object({
            position: z
              .array(z.number())
              .length(3)
              .describe("3D position of the cut point."),
            face: z
              .string()
              .optional()
              .describe("Face key to attach the point to."),
          })
        )
        .min(2)
        .describe("Points defining the cut path."),
    }),
    async execute({ mesh_id, points }) {
      const mesh = Mesh.all.find(
        (m) => m.uuid === mesh_id || m.name === mesh_id
      );
      if (!mesh) {
        throw new Error(`Mesh with ID "${mesh_id}" not found.`);
      }

      Undo.initEdit({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      // Create knife tool context
      // @ts-ignore
      const knifeContext = new KnifeToolContext(mesh);

      // Add points to the knife path
      points.forEach((point) => {
        knifeContext.points.push({
          position: new THREE.Vector3(...point.position),
          fkey: point.face,
          type: point.face ? "face" : "edge",
        });
      });

      // Apply the knife cut
      knifeContext.apply();

      Undo.finishEdit("Knife cut mesh");
      Canvas.updateView({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      return `Applied knife cut to mesh "${mesh.name}" with ${points.length} points`;
    },
  },
  STATUS_EXPERIMENTAL
);






// === PAINT MODE TOOLS ===

createTool(
  "paint_with_brush",
  {
    description:
      "Paints on textures using the brush tool with customizable settings.",
    annotations: {
      title: "Paint with Brush",
      destructiveHint: true,
    },
    parameters: z.object({
      texture_id: z
        .string()
        .optional()
        .describe(
          "Texture ID or name. If not provided, uses selected texture."
        ),
      coordinates: z
        .array(
          z.object({
            x: z.number().describe("X coordinate on texture."),
            y: z.number().describe("Y coordinate on texture."),
          })
        )
        .describe("Array of coordinates to paint at."),
      brush_settings: z
        .object({
          size: z.number().min(1).max(100).optional().describe("Brush size."),
          opacity: z
            .number()
            .min(0)
            .max(255)
            .optional()
            .describe("Brush opacity (0-255)."),
          softness: z
            .number()
            .min(0)
            .max(100)
            .optional()
            .describe("Brush softness percentage."),
          shape: z
            .enum(["square", "circle"])
            .optional()
            .describe("Brush shape."),
          color: z.string().optional().describe("Brush color as hex string."),
          blend_mode: z
            .enum([
              "default",
              "set_opacity",
              "color",
              "behind",
              "multiply",
              "add",
              "screen",
              "overlay",
              "difference",
            ])
            .optional()
            .describe("Brush blend mode."),
        })
        .optional()
        .describe("Brush settings to apply."),
      connect_strokes: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to connect paint strokes with lines."),
    }),
    async execute({
      texture_id,
      coordinates,
      brush_settings,
      connect_strokes,
    }) {
      const texture = texture_id
        ? getProjectTexture(texture_id)
        : Texture.getDefault();

      if (!texture) {
        throw new Error(
          texture_id
            ? `Texture with ID "${texture_id}" not found.`
            : "No texture available."
        );
      }

      Undo.initEdit({
        textures: [texture],
        selected_texture: true,
        bitmap: true,
      });

      // Apply brush settings using .value assignment
      BarItems.slider_brush_size.value = brush_settings.size;
      BarItems.slider_brush_opacity.value = brush_settings.opacity;
      BarItems.slider_brush_softness.value = brush_settings.softness;
      BarItems.brush_shape.value = brush_settings.shape;
      ColorPanel.set(brush_settings.color);

      // Paint using Painter.edit() method
      texture.edit(
        (canvas) => {
          const ctx = canvas.getContext("2d");
          for (const coord of coordinates) {
            if (brush_settings.shape === "circle") {
              Painter.editCircle(
                ctx,
                coord.x,
                coord.y,
                brush_settings.size,
                brush_settings.softness,
                (r, g, b, a) => [red, green, blue, alpha]
              );
            } else {
              Painter.editSquare(
                ctx,
                coord.x,
                coord.y,
                brush_settings.size,
                brush_settings.softness,
                (r, g, b, a) => [red, green, blue, alpha]
              );
            }
          }
        },
        { edit_name: "Paint with brush" }
      );

      Undo.finishEdit("Paint with brush");
      Canvas.updateAll();

      return `Painted ${coordinates.length} points on texture "${texture.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "create_brush_preset",
  {
    description: "Creates a custom brush preset with specified settings.",
    annotations: {
      title: "Create Brush Preset",
      destructiveHint: true,
    },
    parameters: z.object({
      name: z.string().describe("Name of the brush preset."),
      size: z.number().min(1).max(100).optional().describe("Brush size."),
      opacity: z
        .number()
        .min(0)
        .max(255)
        .optional()
        .describe("Brush opacity (0-255)."),
      softness: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Brush softness percentage."),
      shape: z.enum(["square", "circle"]).optional().describe("Brush shape."),
      color: z.string().optional().describe("Brush color as hex string."),
      blend_mode: z
        .enum([
          "default",
          "set_opacity",
          "color",
          "behind",
          "multiply",
          "add",
          "screen",
          "overlay",
          "difference",
        ])
        .optional()
        .describe("Brush blend mode."),
      pixel_perfect: z
        .boolean()
        .optional()
        .describe("Enable pixel perfect drawing."),
    }),
    async execute({
      name,
      size,
      opacity,
      softness,
      shape,
      color,
      blend_mode,
      pixel_perfect,
    }) {
      const preset = {
        name,
        size: size || null,
        opacity: opacity || null,
        softness: softness || null,
        shape: shape || "square",
        color: color || null,
        blend_mode: blend_mode || "default",
        pixel_perfect: pixel_perfect || false,
      };

      // @ts-ignore
      StateMemory.brush_presets.push(preset);
      // @ts-ignore
      StateMemory.save("brush_presets");

      return `Created brush preset "${name}" with settings: ${JSON.stringify(
        preset
      )}`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "load_brush_preset",
  {
    description: "Loads and applies a brush preset by name.",
    annotations: {
      title: "Load Brush Preset",
      destructiveHint: true,
    },
    parameters: z.object({
      preset_name: z.string().describe("Name of the brush preset to load."),
    }),
    async execute({ preset_name }) {
      // @ts-ignore
      const preset = StateMemory.brush_presets.find(
        (p) => p.name === preset_name
      );

      if (!preset) {
        throw new Error(`Brush preset "${preset_name}" not found.`);
      }

      // @ts-ignore
      Painter.loadBrushPreset(preset);

      return `Loaded brush preset "${preset_name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "texture_selection",
  {
    description:
      "Creates, modifies, or manipulates texture selections for painting.",
    annotations: {
      title: "Texture Selection",
      destructiveHint: true,
    },
    parameters: z.object({
      action: z
        .enum([
          "select_rectangle",
          "select_ellipse",
          "select_all",
          "clear_selection",
          "invert_selection",
          "expand_selection",
          "contract_selection",
          "feather_selection",
        ])
        .describe("Selection action to perform."),
      texture_id: z
        .string()
        .optional()
        .describe(
          "Texture ID or name. If not provided, uses selected texture."
        ),
      coordinates: z
        .object({
          x1: z.number().describe("Start X coordinate."),
          y1: z.number().describe("Start Y coordinate."),
          x2: z.number().describe("End X coordinate."),
          y2: z.number().describe("End Y coordinate."),
        })
        .optional()
        .describe("Selection area coordinates."),
      radius: z
        .number()
        .optional()
        .describe("Radius for expand/contract/feather operations."),
      mode: z
        .enum(["create", "add", "subtract", "intersect"])
        .optional()
        .default("create")
        .describe("Selection mode."),
    }),
    async execute({ action, texture_id, coordinates, radius, mode }) {
      const texture = texture_id
        ? getProjectTexture(texture_id)
        : Texture.getDefault();

      if (!texture) {
        throw new Error(
          texture_id
            ? `Texture with ID "${texture_id}" not found.`
            : "No texture available."
        );
      }

      Undo.initEdit({
        textures: [texture],
        bitmap: true,
      });

      const selection = texture.selection;

      switch (action) {
        case "select_rectangle":
          if (!coordinates) {
            throw new Error("Coordinates required for rectangle selection.");
          }
          selection.clear();
          selection.start_x = coordinates.x1;
          selection.start_y = coordinates.y1;
          selection.end_x = coordinates.x2;
          selection.end_y = coordinates.y2;
          selection.is_custom = false;
          break;

        case "select_ellipse":
          if (!coordinates) {
            throw new Error("Coordinates required for ellipse selection.");
          }
          selection.clear();
          // Create elliptical selection
          selection.is_custom = true;
          const centerX = (coordinates.x1 + coordinates.x2) / 2;
          const centerY = (coordinates.y1 + coordinates.y2) / 2;
          const radiusX = Math.abs(coordinates.x2 - coordinates.x1) / 2;
          const radiusY = Math.abs(coordinates.y2 - coordinates.y1) / 2;

          for (
            let x = Math.floor(centerX - radiusX);
            x <= Math.ceil(centerX + radiusX);
            x++
          ) {
            for (
              let y = Math.floor(centerY - radiusY);
              y <= Math.ceil(centerY + radiusY);
              y++
            ) {
              const dx = (x - centerX) / radiusX;
              const dy = (y - centerY) / radiusY;
              if (dx * dx + dy * dy <= 1) {
                selection.set(x, y, true);
              }
            }
          }
          break;

        case "select_all":
          selection.selectAll();
          break;

        case "clear_selection":
          selection.clear();
          break;

        case "invert_selection":
          selection.invert();
          break;

        case "expand_selection":
          if (radius === undefined) {
            throw new Error("Radius required for expand selection.");
          }
          selection.expand(radius);
          break;

        case "contract_selection":
          if (radius === undefined) {
            throw new Error("Radius required for contract selection.");
          }
          selection.contract(radius);
          break;

        case "feather_selection":
          if (radius === undefined) {
            throw new Error("Radius required for feather selection.");
          }
          selection.feather(radius);
          break;
      }

      // Update UI
      UVEditor.vue.updateTexture();

      Undo.finishEdit("Texture selection");

      return `Applied ${action} to texture "${texture.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "texture_layer_management",
  {
    description: "Creates, manages, and manipulates texture layers.",
    annotations: {
      title: "Texture Layer Management",
      destructiveHint: true,
    },
    parameters: z.object({
      action: z
        .enum([
          "create_layer",
          "delete_layer",
          "duplicate_layer",
          "merge_down",
          "set_opacity",
          "set_blend_mode",
          "move_layer",
          "rename_layer",
          "flatten_layers",
        ])
        .describe("Layer management action."),
      texture_id: z
        .string()
        .optional()
        .describe(
          "Texture ID or name. If not provided, uses selected texture."
        ),
      layer_name: z.string().optional().describe("Name of the layer."),
      opacity: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Layer opacity percentage."),
      blend_mode: z
        .enum([
          "normal",
          "multiply",
          "screen",
          "overlay",
          "soft_light",
          "hard_light",
          "color_dodge",
          "color_burn",
          "darken",
          "lighten",
          "difference",
          "exclusion",
        ])
        .optional()
        .describe("Layer blend mode."),
      target_index: z
        .number()
        .optional()
        .describe("Target position for moving layers."),
    }),
    async execute({
      action,
      texture_id,
      layer_name,
      opacity,
      blend_mode,
      target_index,
    }) {
      const texture = texture_id
        ? getProjectTexture(texture_id)
        : Texture.selected;

      if (!texture) {
        throw new Error(
          texture_id
            ? `Texture with ID "${texture_id}" not found.`
            : "No texture selected."
        );
      }

      Undo.initEdit({
        textures: [texture],
        layers: texture.layers,
        bitmap: true,
      });

      let result = "";

      switch (action) {
        case "create_layer":
          if (!texture.layers_enabled) {
            texture.activateLayers(true);
          }
          const newLayer = new TextureLayer(
            {
              name: layer_name || `Layer ${texture.layers.length + 1}`,
            },
            texture
          );
          newLayer.setSize(texture.width, texture.height);
          newLayer.addForEditing();
          result = `Created layer "${newLayer.name}"`;
          break;

        case "delete_layer":
          if (!TextureLayer.selected) {
            throw new Error("No layer selected.");
          }
          const layerToDelete = TextureLayer.selected;
          layerToDelete.remove();
          result = `Deleted layer "${layerToDelete.name}"`;
          break;

        case "duplicate_layer":
          if (!TextureLayer.selected) {
            throw new Error("No layer selected.");
          }
          const layerToDuplicate = TextureLayer.selected;
          const duplicatedLayer = layerToDuplicate.duplicate();
          duplicatedLayer.name = `${layerToDuplicate.name} copy`;
          result = `Duplicated layer "${duplicatedLayer.name}"`;
          break;

        case "merge_down":
          if (!TextureLayer.selected) {
            throw new Error("No layer selected.");
          }
          TextureLayer.selected.mergeDown(true);
          result = "Merged layer down";
          break;

        case "set_opacity":
          if (!TextureLayer.selected) {
            throw new Error("No layer selected.");
          }
          if (opacity === undefined) {
            throw new Error("Opacity value required.");
          }
          TextureLayer.selected.opacity = opacity / 100;
          texture.updateChangesAfterEdit();
          result = `Set layer opacity to ${opacity}%`;
          break;

        case "set_blend_mode":
          if (!TextureLayer.selected) {
            throw new Error("No layer selected.");
          }
          if (!blend_mode) {
            throw new Error("Blend mode required.");
          }
          TextureLayer.selected.blend_mode = blend_mode;
          texture.updateChangesAfterEdit();
          result = `Set layer blend mode to ${blend_mode}`;
          break;

        case "move_layer":
          if (!TextureLayer.selected) {
            throw new Error("No layer selected.");
          }
          if (target_index === undefined) {
            throw new Error("Target index required.");
          }
          const layerToMove = TextureLayer.selected;
          texture.layers.remove(layerToMove);
          texture.layers.splice(target_index, 0, layerToMove);
          result = `Moved layer to position ${target_index}`;
          break;

        case "rename_layer":
          if (!TextureLayer.selected) {
            throw new Error("No layer selected.");
          }
          if (!layer_name) {
            throw new Error("New layer name required.");
          }
          const oldName = TextureLayer.selected.name;
          TextureLayer.selected.name = layer_name;
          result = `Renamed layer from "${oldName}" to "${layer_name}"`;
          break;

        case "flatten_layers":
          if (!texture.layers_enabled) {
            throw new Error("Texture has no layers to flatten.");
          }
          texture.flattenLayers();
          result = "Flattened all layers";
          break;
      }

      texture.updateChangesAfterEdit();
      Undo.finishEdit(`Layer management: ${action}`);
      updateInterfacePanels();

      return result;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "duplicate_element",
  {
    description:
      "Duplicates a cube, mesh or group by ID or name.  You may offset the duplicate or assign a new name.",
    annotations: { title: "Duplicate Element", destructiveHint: true },
    parameters: z.object({
      id: z.string().describe("ID or name of the element to duplicate."),
      offset: z
        .array(z.number())
        .length(3)
        .optional()
        .default([0, 0, 0]),
      newName: z.string().optional(),
    }),
    async execute({ id, offset, newName }) {
      const element =
        Outliner.root.find((el) => el.uuid === id || el.name === id) ?? null;
      if (!element) throw new Error(`Element "${id}" not found.`);

      // Helper functions for each type; match patterns used in existing tools:contentReference[oaicite:5]{index=5}.
      function cloneCube(cube: Cube, parent: any) {
        const dupe = new Cube({
          name: newName || `${cube.name}_copy`,
          from: cube.from.map((v, i) => v + offset[i]),
          to: cube.to.map((v, i) => v + offset[i]),
          origin: cube.origin.map((v, i) => v + offset[i]),
          rotation: cube.rotation,
          autouv: cube.autouv,
          uv_offset: cube.uv_offset,
          mirror_uv: cube.mirror_uv,
          shade: cube.shade,
          inflate: cube.inflate,
          color: cube.color,
          visibility: cube.visibility,
        }).init();
        dupe.addTo(parent);
        return dupe;
      }

      function cloneGroup(group: Group, parent: any) {
        const dupeGroup = new Group({
          name: newName || `${group.name}_copy`,
          origin: group.origin.map((v, i) => v + offset[i]),
          rotation: group.rotation,
          autouv: group.autouv,
          selected: group.selected,
          shade: group.shade,
          visibility: group.visibility,
        }).init();
        dupeGroup.addTo(parent);
        group.children.forEach((child: any) => cloneElement(child, dupeGroup));
        return dupeGroup;
      }

      function cloneMesh(mesh: Mesh, parent: any) {
        const dupe = new Mesh({
          name: newName || `${mesh.name}_copy`,
          vertices: {},
          origin: mesh.origin.map((v, i) => v + offset[i]),
          rotation: mesh.rotation,
        }).init();
        const map: Record<string, any> = {};
        Object.entries(mesh.vertices).forEach(([key, coords]: [any, any]) => {
          map[key] = dupe.addVertices([
            coords[0] + offset[0],
            coords[1] + offset[1],
            coords[2] + offset[2],
          ])[0];
        });
        mesh.faces.forEach((face: any) => {
          dupe.addFaces(
            new MeshFace(dupe, {
              vertices: face.vertices.map((v: any) => map[v]),
              uv: face.uv,
            })
          );
        });
        dupe.addTo(parent);
        if ((mesh as any).material) dupe.applyTexture((mesh as any).material);
        return dupe;
      }

      function cloneElement(el: any, parent: any) {
        if (el instanceof Cube) return cloneCube(el, parent);
        if (el instanceof Group) return cloneGroup(el, parent);
        if (el instanceof Mesh) return cloneMesh(el, parent);
        throw new Error("Unsupported element type.");
      }

      Undo.initEdit({ elements: [], outliner: true, collections: [] });
      const dup = cloneElement(element, element.parent ?? Outliner);
      Undo.finishEdit("Agent duplicated element");
      Canvas.updateAll();
      return `Duplicated "${element.name}" as "${dup.name}" (ID: ${dup.uuid}).`;
    },
  },
  STATUS_EXPERIMENTAL
);

/**
 * Rename an element.  Mirrors the simple property change seen in the existing tools,
 * using `extend` to apply the change and updating the editor.
 */
createTool(
  "rename_element",
  {
    description: "Renames a cube, mesh or group by ID or name.",
    annotations: { title: "Rename Element", destructiveHint: true },
    parameters: z.object({
      id: z.string().describe("ID or name of the element to rename."),
      new_name: z.string().describe("New name to assign."),
    }),
    async execute({ id, new_name }) {
      const element = Outliner.root.find(
        (el) => el.uuid === id || el.name === id
      );
      if (!element) throw new Error(`Element "${id}" not found.`);
      Undo.initEdit({ elements: [element], outliner: true, collections: [] });
      element.extend({ name: new_name });
      Undo.finishEdit("Agent renamed element");
      Canvas.updateAll();
      return `Renamed element "${id}" to "${new_name}".`;
    },
  },
  STATUS_EXPERIMENTAL
);
