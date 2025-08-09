/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, tools } from "@/lib/factories";
import {
  getProjectTexture,
  captureScreenshot,
  captureAppScreenshot,
} from "@/lib/util";
import { imageContent } from "fastmcp";

const STATUS_STABLE = "stable";
const STATUS_EXPERIMENTAL = "experimental";

createTool(
  "place_cube",
  {
    description:
      "Places a cube of the given size at the specified position. Texture and group are optional.",
    annotations: {
      title: "Place Cube",
      destructiveHint: true,
    },
    parameters: z.object({
      elements: z
        .array(
          z.object({
            name: z.string(),
            origin: z
              .tuple([z.number(), z.number(), z.number()])
              .describe("Pivot point of the cube."),
            from: z
              .tuple([z.number(), z.number(), z.number()])
              .describe("Starting point of the cube."),
            to: z
              .tuple([z.number(), z.number(), z.number()])
              .describe("Ending point of the cube."),
            rotation: z
              .tuple([z.number(), z.number(), z.number()])
              .describe("Rotation of the cube."),
          })
        )
        .min(1)
        .describe("Array of cubes to place."),
      texture: z
        .string()
        .optional()
        .describe("Texture ID or name to apply to the cube."),
      group: z
        .string()
        .optional()
        .describe("Group/bone to which the cube belongs."),
      faces: z
        .union([
          z
            .array(z.enum(["north", "south", "east", "west", "up", "down"]))
            .describe("Array of faces to apply the texture to."),
          z
            .boolean()
            .optional()
            .describe(
              "Whether to apply the texture to all faces. Set to `true` to enable auto UV mapping."
            ),
          z
            .array(
              z.object({
                face: z
                  .enum(["north", "south", "east", "west", "up", "down"])
                  .describe("Face to apply the texture to."),
                uv: z
                  .tuple([z.number(), z.number(), z.number(), z.number()])
                  .describe("Custom UV mapping for the face."),
              })
            )
            .describe("Array of faces with custom UV mapping."),
        ])
        .optional()
        .default(true)
        .describe(
          "Faces to apply the texture to. Set to `true` to enable auto UV mapping."
        ),
    }),
    async execute({ elements, texture, faces, group }, { reportProgress }) {
      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
      });
      const total = elements.length;

      const projectTexture = texture
        ? getProjectTexture(texture)
        : Texture.getDefault();

      if (!projectTexture) {
        throw new Error(`No texture found for "${texture}".`);
      }

      const groups = getAllGroups();
      const outlinerGroup = groups.find(
        (g) => g.name === group || g.uuid === group
      );

      const autouv =
        faces === true ||
        (Array.isArray(faces) &&
          faces.every((face) => typeof face === "string"));

      const cubes = elements.map((element, progress) => {
        const cube = new Cube({
          autouv: autouv ? 1 : 0,
          name: element.name,
          from: element.from,
          to: element.to,
          origin: element.origin,
          rotation: element.rotation,
        }).init();

        cube.addTo(outlinerGroup);

        if (!autouv && Array.isArray(faces)) {
          faces.forEach(({ face, uv }) => {
            cube.faces[face].extend({
              uv,
            });
          });
        } else {
          cube.applyTexture(
            projectTexture,
            faces !== false ? faces : undefined
          );
          cube.mapAutoUV();
        }

        reportProgress({
          progress,
          total,
        });

        return cube;
      });

      Undo.finishEdit("Agent placed cubes");
      Canvas.updateAll();

      return await Promise.resolve(
        JSON.stringify(
          cubes.map((cube) => `Added cube ${cube.name} with ID ${cube.uuid}`)
        )
      );
    },
  },
  STATUS_STABLE
);

createTool(
  "place_mesh",
  {
    description:
      "Places a mesh at the specified position. Texture and group are optional.",
    annotations: {
      title: "Place Mesh",
      destructiveHint: true,
    },
    parameters: z.object({
      elements: z
        .array(
          z.object({
            name: z.string(),
            position: z
              .tuple([z.number(), z.number(), z.number()])
              .describe("Position of the mesh."),
            rotation: z
              .tuple([z.number(), z.number(), z.number()])
              .describe("Rotation of the mesh."),
            scale: z
              .tuple([z.number(), z.number(), z.number()])
              .describe("Scale of the mesh."),
            vertices: z
              .array(
                z
                  .tuple([z.number(), z.number(), z.number()])
                  .describe("Vertex coordinates in the mesh.")
              )
              .describe("Vertices of the mesh."),
          })
        )
        .min(1)
        .describe("Array of meshes to place."),
      texture: z
        .string()
        .optional()
        .describe("Texture ID or name to apply to the mesh."),
      group: z
        .string()
        .optional()
        .describe("Group/bone to which the mesh belongs."),
    }),
    async execute({ elements, texture, group }, { reportProgress }) {
      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
      });
      const total = elements.length;

      const projectTexture = texture
        ? getProjectTexture(texture)
        : Texture.getDefault();

      if (!projectTexture) {
        throw new Error(`No texture found for "${texture}".`);
      }

      // @ts-expect-error getAllGroups is a utility function that returns all groups in the project
      const groups = getAllGroups();
      const outlinerGroup = groups.find(
        (g) => g.name === group || g.uuid === group
      );

      const meshes = elements.map((element, progress) => {
        const mesh = new Mesh({
          name: element.name,
          vertices: {},
        }).init();

        element.vertices.forEach((vertex) => {
          mesh.addVertices(vertex);
        });

        mesh.addTo(outlinerGroup);
        mesh.applyTexture(projectTexture);

        reportProgress({
          progress,
          total,
        });

        return mesh;
      });

      Undo.finishEdit("Agent placed meshes");
      Canvas.updateAll();

      return await Promise.resolve(
        JSON.stringify(
          meshes.map((mesh) => `Added mesh ${mesh.name} with ID ${mesh.uuid}`)
        )
      );
    },
  },
  STATUS_EXPERIMENTAL
);

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
            z.tuple([
              z.number().min(0).max(255).describe("Red channel"),
              z.number().min(0).max(255).describe("Green channel"),
              z.number().min(0).max(255).describe("Blue channel"),
              z.number().default(255).describe("Alpha channel"),
            ]),
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
  "modify_cube",
  {
    description:
      "Modifies the cube with the given ID. Auto UV setting: saved as an integer, where 0 means disabled, 1 means enabled, and 2 means relative auto UV (cube position affects UV)",
    annotations: {
      title: "Modify Cube",
      destructiveHint: true,
    },
    parameters: z.object({
      id: z
        .string()
        .optional()
        .describe(
          "ID or name of the cube to modify. Defaults to selected, which could be more than one."
        ),
      name: z.string().optional().describe("New name of the cube."),
      origin: z
        .tuple([z.number(), z.number(), z.number()])
        .optional()
        .describe("Pivot point of the cube."),
      from: z
        .tuple([z.number(), z.number(), z.number()])
        .optional()
        .describe("Starting point of the cube."),
      to: z
        .tuple([z.number(), z.number(), z.number()])
        .optional()
        .describe("Ending point of the cube."),
      rotation: z
        .tuple([z.number(), z.number(), z.number()])
        .optional()
        .describe("Rotation of the cube."),
      autouv: z
        .enum(["0", "1", "2"])
        .optional()
        .describe(
          "Auto UV setting. 0 = disabled, 1 = enabled, 2 = relative auto UV."
        ),
      uv_offset: z
        .tuple([z.number(), z.number()])
        .optional()
        .describe("UV offset for the texture."),
      mirror_uv: z.boolean().optional().describe("Whether to mirror the UVs."),
      shade: z
        .boolean()
        .optional()
        .describe("Whether to apply shading to the cube."),
      inflate: z.number().optional().describe("Inflation amount for the cube."),
      color: z
        .number()
        .optional()
        .describe("Single digit to represent a color from a palette."),
      visibility: z
        .boolean()
        .optional()
        .describe("Whether the cube is visible or not."),
    }),
    async execute({
      id,
      name,
      origin,
      from,
      to,
      rotation,
      uv_offset,
      autouv,
      mirror_uv,
      shade,
      inflate,
      color,
      visibility,
    }) {
      const cubes = (Outliner.root.filter(
        (el) => el instanceof Cube && (el.uuid === id || el.name === id)
      ) ?? Cube.selected) as Cube[];

      if (!cubes.length) {
        throw new Error(`Cube with ID "${id}" not found.`);
      }

      Undo.initEdit({
        elements: Array.isArray(cubes) ? cubes : [cubes],
        outliner: true,
        collections: [],
      });

      cubes.forEach((cube) => {
        cube.extend({
          name: name ?? cube.name,
          origin: origin ?? cube.origin,
          from: from ?? cube.from,
          to: to ?? cube.to,
          rotation: rotation ?? cube.rotation,
          uv_offset: uv_offset ?? cube.uv_offset,
          autouv: autouv ? (Number(autouv) as 0 | 1 | 2) : cube.autouv,
          mirror_uv: Boolean(mirror_uv ?? cube.mirror_uv),
          inflate: inflate ?? cube.inflate,
          color: color ?? cube.color,
          visibility: visibility ?? cube.visibility,
          shade: shade ?? cube.shade,
        });
      });

      Undo.finishEdit("Agent modified cubes");
      Canvas.updateAll();

      return `Modified cubes ${cubes
        .map((cube) => cube.name)
        .join(", ")} with IDs ${cubes.map((cube) => cube.uuid).join(", ")}`;
    },
  },
  STATUS_STABLE
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
      origin: z.tuple([z.number(), z.number(), z.number()]),
      rotation: z.tuple([z.number(), z.number(), z.number()]),
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
          .tuple([z.number(), z.number(), z.number()])
          .describe("Camera position."),
        target: z
          .tuple([z.number(), z.number(), z.number()])
          .optional()
          .describe("Camera target position."),
        rotation: z
          .tuple([z.number(), z.number(), z.number()])
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
  "create_animation",
  {
    description: "Creates a new animation with keyframes for bones.",
    annotations: {
      title: "Create Animation",
      destructiveHint: true,
    },
    parameters: z.object({
      name: z.string().describe("Name of the animation"),
      loop: z
        .boolean()
        .default(false)
        .describe("Whether the animation should loop"),
      animation_length: z
        .number()
        .optional()
        .describe("Length of the animation in seconds"),
      bones: z
        .record(
          z.array(
            z.object({
              time: z.number(),
              position: z
                .tuple([z.number(), z.number(), z.number()])
                .optional(),
              rotation: z
                .tuple([z.number(), z.number(), z.number()])
                .optional(),
              scale: z
                .union([
                  z.tuple([z.number(), z.number(), z.number()]),
                  z.number(),
                ])
                .optional(),
            })
          )
        )
        .describe("Keyframes for each bone"),
      particle_effects: z
        .record(z.string().describe("Effect name"))
        .optional()
        .describe("Particle effects with timestamps as keys"),
    }),
    async execute({ name, loop, animation_length, bones, particle_effects }) {
      const animationData = {
        loop,
        ...(animation_length && { animation_length }),
        bones: Object.fromEntries(
          Object.entries(bones).map(([boneName, keyframes]) => {
            const boneData: Record<
              string,
              Record<string, number | number[]>
            > = keyframes.reduce((acc, keyframe) => {
              const timeKey = keyframe.time.toString();
              if (keyframe.position) {
                (acc.position ??= {})[timeKey] = keyframe.position;
              }
              if (keyframe.rotation) {
                (acc.rotation ??= {})[timeKey] = keyframe.rotation;
              }
              if (keyframe.scale) {
                (acc.scale ??= {})[timeKey] = keyframe.scale;
              }
              return acc;
            }, {} as Record<string, Record<string, number | number[]>>);

            return [boneName, boneData];
          })
        ),
        ...(particle_effects && { particle_effects }),
      };

      Animator.loadFile({
        content: JSON.stringify({
          format_version: "1.8.0",
          animations: {
            [`animation.${name}`]: animationData,
          },
        }),
      });

      return `Created animation "${name}" with keyframes for ${
        Object.keys(bones).length
      } bones${
        particle_effects
          ? ` and ${Object.keys(particle_effects).length} particle effects`
          : ""
      }`;
    },
  },
  STATUS_STABLE
);

createTool(
  "manage_keyframes",
  {
    description:
      "Creates, deletes, or edits keyframes in the animation timeline for specific bones and channels.",
    annotations: {
      title: "Manage Keyframes",
      destructiveHint: true,
    },
    parameters: z.object({
      animation_id: z
        .string()
        .optional()
        .describe(
          "Animation UUID or name. If not provided, uses current animation."
        ),
      action: z
        .enum(["create", "delete", "edit", "select"])
        .describe("Action to perform on keyframes."),
      bone_name: z
        .string()
        .describe("Name of the bone/group to manage keyframes for."),
      channel: z
        .enum(["rotation", "position", "scale"])
        .describe("Animation channel to modify."),
      keyframes: z
        .array(
          z.object({
            time: z.number().describe("Time in seconds for the keyframe."),
            values: z
              .union([
                z.tuple([z.number(), z.number(), z.number()]),
                z.number(),
              ])
              .optional()
              .describe(
                "Values for the keyframe. [x,y,z] for position/rotation, number for uniform scale."
              ),
            interpolation: z
              .enum(["linear", "catmullrom", "bezier", "step"])
              .optional()
              .default("linear")
              .describe("Interpolation type for the keyframe."),
            bezier_handles: z
              .object({
                left_time: z.number().optional(),
                left_value: z
                  .tuple([z.number(), z.number(), z.number()])
                  .optional(),
                right_time: z.number().optional(),
                right_value: z
                  .tuple([z.number(), z.number(), z.number()])
                  .optional(),
              })
              .optional()
              .describe("Bezier handle positions for bezier interpolation."),
          })
        )
        .describe("Keyframe data for the action."),
    }),
    async execute({ animation_id, action, bone_name, channel, keyframes }) {
      // Find or select animation
      const animation = animation_id
        ? Animation.all.find(
            (a) => a.uuid === animation_id || a.name === animation_id
          )
        : Animation.selected;

      if (!animation) {
        throw new Error("No animation found or selected.");
      }

      // Find the bone
      const group = Group.all.find((g) => g.name === bone_name);
      if (!group) {
        throw new Error(`Bone/group "${bone_name}" not found.`);
      }

      // Get or create animator
      let animator = animation.animators[group.uuid];
      if (!animator) {
        animator = new BoneAnimator(group.uuid, animation, bone_name);
        animation.animators[group.uuid] = animator;
      }

      Undo.initEdit({
        animations: [animation],
        keyframes: [],
      });

      switch (action) {
        case "create":
          keyframes.forEach((kf) => {
            const keyframe = animator.createKeyframe(
              {
                time: kf.time,
                channel,
                values: kf.values,
                interpolation: kf.interpolation,
              },
              kf.time,
              channel,
              false
            );

            if (kf.interpolation === "bezier" && kf.bezier_handles) {
              // @ts-ignore
              if (kf.bezier_handles.left_time !== undefined)
                keyframe.bezier_left_time = kf.bezier_handles.left_time;
              // @ts-ignore
              if (kf.bezier_handles.left_value)
                keyframe.bezier_left_value = kf.bezier_handles.left_value;
              // @ts-ignore
              if (kf.bezier_handles.right_time !== undefined)
                keyframe.bezier_right_time = kf.bezier_handles.right_time;
              // @ts-ignore
              if (kf.bezier_handles.right_value)
                keyframe.bezier_right_value = kf.bezier_handles.right_value;
            }
          });
          break;

        case "delete":
          keyframes.forEach((kf) => {
            const keyframe = animator[channel]?.find(
              (k) => Math.abs(k.time - kf.time) < 0.001
            );
            if (keyframe) {
              keyframe.remove();
            }
          });
          break;

        case "edit":
          keyframes.forEach((kf) => {
            const keyframe = animator[channel]?.find(
              (k) => Math.abs(k.time - kf.time) < 0.001
            );
            if (keyframe) {
              if (kf.values) {
                keyframe.set("values", kf.values);
              }
              if (kf.interpolation) {
                keyframe.interpolation = kf.interpolation;
              }
              if (kf.interpolation === "bezier" && kf.bezier_handles) {
                // @ts-ignore
                if (kf.bezier_handles.left_time !== undefined)
                  keyframe.bezier_left_time = kf.bezier_handles.left_time;
                // @ts-ignore
                if (kf.bezier_handles.left_value)
                  keyframe.bezier_left_value = kf.bezier_handles.left_value;
                // @ts-ignore
                if (kf.bezier_handles.right_time !== undefined)
                  keyframe.bezier_right_time = kf.bezier_handles.right_time;
                // @ts-ignore
                if (kf.bezier_handles.right_value)
                  keyframe.bezier_right_value = kf.bezier_handles.right_value;
              }
            }
          });
          break;

        case "select":
          Timeline.selected.empty();
          keyframes.forEach((kf) => {
            const keyframe = animator[channel]?.find(
              (k) => Math.abs(k.time - kf.time) < 0.001
            );
            if (keyframe) {
              keyframe.select();
            }
          });
          break;
      }

      Undo.finishEdit(`${action} keyframes`);
      Animator.preview();

      return `Successfully performed ${action} on ${keyframes.length} keyframes for ${bone_name}.${channel}`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "animation_graph_editor",
  {
    description:
      "Controls animation curves in the graph editor for fine-tuning animations.",
    annotations: {
      title: "Animation Graph Editor",
      destructiveHint: true,
    },
    parameters: z.object({
      animation_id: z
        .string()
        .optional()
        .describe(
          "Animation UUID or name. If not provided, uses current animation."
        ),
      bone_name: z
        .string()
        .describe("Name of the bone/group to modify curves for."),
      channel: z
        .enum(["rotation", "position", "scale"])
        .describe("Animation channel to modify."),
      axis: z
        .enum(["x", "y", "z", "all"])
        .default("all")
        .describe("Axis to modify curves for."),
      action: z
        .enum([
          "smooth",
          "linear",
          "ease_in",
          "ease_out",
          "ease_in_out",
          "stepped",
          "custom",
        ])
        .describe("Type of curve modification to apply."),
      keyframe_range: z
        .object({
          start: z.number().describe("Start time of the range."),
          end: z.number().describe("End time of the range."),
        })
        .optional()
        .describe(
          "Time range to apply the curve modification. If not provided, applies to all keyframes."
        ),
      custom_curve: z
        .object({
          control_point_1: z
            .tuple([z.number(), z.number()])
            .describe("First control point [time, value]."),
          control_point_2: z
            .tuple([z.number(), z.number()])
            .describe("Second control point [time, value]."),
        })
        .optional()
        .describe(
          "Custom bezier curve control points (only for 'custom' action)."
        ),
    }),
    async execute({
      animation_id,
      bone_name,
      channel,
      axis,
      action,
      keyframe_range,
      custom_curve,
    }) {
      const animation = animation_id
        ? Animation.all.find(
            (a) => a.uuid === animation_id || a.name === animation_id
          )
        : Animation.selected;

      if (!animation) {
        throw new Error("No animation found or selected.");
      }

      const group = Group.all.find((g) => g.name === bone_name);
      if (!group) {
        throw new Error(`Bone/group "${bone_name}" not found.`);
      }

      const animator = animation.animators[group.uuid];
      if (!animator || !animator[channel]) {
        throw new Error(`No keyframes found for ${bone_name}.${channel}`);
      }

      Undo.initEdit({
        animations: [animation],
        keyframes: animator[channel],
      });

      const keyframes = animator[channel].filter((kf) => {
        if (!keyframe_range) return true;
        return kf.time >= keyframe_range.start && kf.time <= keyframe_range.end;
      });

      keyframes.forEach((kf, index) => {
        switch (action) {
          case "linear":
            kf.interpolation = "linear";
            break;

          case "stepped":
            kf.interpolation = "step";
            break;

          case "smooth":
            kf.interpolation = "catmullrom";
            break;

          case "ease_in":
          case "ease_out":
          case "ease_in_out":
            kf.interpolation = "bezier";
            // Set bezier handles based on easing type
            const next = keyframes[index + 1];
            if (next) {
              const duration = next.time - kf.time;
              // @ts-ignore
              kf.bezier_left_time = 0;
              // @ts-ignore
              kf.bezier_right_time = duration;

              if (action === "ease_in") {
                // @ts-ignore
                kf.bezier_right_time = duration * 0.6;
              } else if (action === "ease_out") {
                // @ts-ignore
                kf.bezier_left_time = duration * 0.4;
              } else {
                // @ts-ignore
                kf.bezier_left_time = duration * 0.3;
                // @ts-ignore
                kf.bezier_right_time = duration * 0.7;
              }
            }
            break;

          case "custom":
            if (!custom_curve) {
              throw new Error("custom_curve is required for 'custom' action.");
            }
            kf.interpolation = "bezier";
            // @ts-ignore
            kf.bezier_left_time = custom_curve.control_point_1[0];
            // @ts-ignore
            kf.bezier_left_value = [
              custom_curve.control_point_1[1],
              custom_curve.control_point_1[1],
              custom_curve.control_point_1[1],
            ];
            // @ts-ignore
            kf.bezier_right_time = custom_curve.control_point_2[0];
            // @ts-ignore
            kf.bezier_right_value = [
              custom_curve.control_point_2[1],
              custom_curve.control_point_2[1],
              custom_curve.control_point_2[1],
            ];
            break;
        }
      });

      Undo.finishEdit("Modify animation curves");
      Animator.preview();
      updateKeyframeSelection();

      return `Applied ${action} curve to ${keyframes.length} keyframes in ${bone_name}.${channel}`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "bone_rigging",
  {
    description:
      "Creates and manipulates the bone structure (rig) of a model for animation.",
    annotations: {
      title: "Bone Rigging",
      destructiveHint: true,
    },
    parameters: z.object({
      action: z
        .enum([
          "create",
          "parent",
          "unparent",
          "delete",
          "rename",
          "set_pivot",
          "set_ik",
          "mirror",
        ])
        .describe("Action to perform on the bone structure."),
      bone_data: z
        .object({
          name: z.string().describe("Name of the bone."),
          parent: z.string().optional().describe("Parent bone name."),
          origin: z
            .tuple([z.number(), z.number(), z.number()])
            .optional()
            .describe("Pivot point of the bone."),
          rotation: z
            .tuple([z.number(), z.number(), z.number()])
            .optional()
            .describe("Initial rotation of the bone."),
          children: z
            .array(z.string())
            .optional()
            .describe("Names of elements to add to this bone."),
          ik_enabled: z
            .boolean()
            .optional()
            .describe("Enable inverse kinematics for this bone."),
          ik_target: z
            .string()
            .optional()
            .describe("Target bone for IK chain."),
          mirror_axis: z
            .enum(["x", "y", "z"])
            .optional()
            .describe("Axis to mirror the bone across."),
        })
        .describe("Bone configuration data."),
    }),
    async execute({ action, bone_data }) {
      Undo.initEdit({
        outliner: true,
        elements: [],
        groups: [],
      });

      let result = "";

      switch (action) {
        case "create": {
          const group = new Group({
            name: bone_data.name,
            origin: bone_data.origin || [0, 0, 0],
            rotation: bone_data.rotation || [0, 0, 0],
          }).init();

          // Set parent
          if (bone_data.parent) {
            const parent = Group.all.find((g) => g.name === bone_data.parent);
            if (parent) {
              group.addTo(parent);
            }
          }

          // Add children elements
          if (bone_data.children) {
            bone_data.children.forEach((childName) => {
              const element = Outliner.elements.find(
                (e) => e.name === childName
              );
              if (element) {
                element.addTo(group);
              }
            });
          }

          // Set up IK if requested
          if (bone_data.ik_enabled && bone_data.ik_target) {
            // @ts-ignore
            group.ik_enabled = true;
            // @ts-ignore
            group.ik_target = bone_data.ik_target;
          }

          result = `Created bone "${group.name}" with UUID ${group.uuid}`;
          break;
        }

        case "parent": {
          const child = Group.all.find((g) => g.name === bone_data.name);
          const parent = bone_data.parent
            ? Group.all.find((g) => g.name === bone_data.parent)
            : "root";

          if (!child) {
            throw new Error(`Bone "${bone_data.name}" not found.`);
          }

          child.addTo(parent);
          result = `Parented "${bone_data.name}" to "${
            bone_data.parent || "root"
          }"`;
          break;
        }

        case "unparent": {
          const bone = Group.all.find((g) => g.name === bone_data.name);
          if (!bone) {
            throw new Error(`Bone "${bone_data.name}" not found.`);
          }

          bone.addTo("root");
          result = `Unparented "${bone_data.name}"`;
          break;
        }

        case "delete": {
          const bone = Group.all.find((g) => g.name === bone_data.name);
          if (!bone) {
            throw new Error(`Bone "${bone_data.name}" not found.`);
          }

          bone.remove();
          result = `Deleted bone "${bone_data.name}"`;
          break;
        }

        case "rename": {
          const bone = Group.all.find((g) => g.name === bone_data.name);
          if (!bone) {
            throw new Error(`Bone "${bone_data.name}" not found.`);
          }

          const newName = bone_data.children?.[0] || "new_name";
          bone.name = newName;
          result = `Renamed bone to "${newName}"`;
          break;
        }

        case "set_pivot": {
          const bone = Group.all.find((g) => g.name === bone_data.name);
          if (!bone) {
            throw new Error(`Bone "${bone_data.name}" not found.`);
          }

          if (bone_data.origin) {
            bone.origin = bone_data.origin;
          }
          result = `Set pivot point for "${bone_data.name}"`;
          break;
        }

        case "set_ik": {
          const bone = Group.all.find((g) => g.name === bone_data.name);
          if (!bone) {
            throw new Error(`Bone "${bone_data.name}" not found.`);
          }

          // @ts-ignore
          bone.ik_enabled = bone_data.ik_enabled || false;
          if (bone_data.ik_target) {
            // @ts-ignore
            bone.ik_target = bone_data.ik_target;
          }
          result = `Updated IK settings for "${bone_data.name}"`;
          break;
        }

        case "mirror": {
          const bone = Group.all.find((g) => g.name === bone_data.name);
          if (!bone) {
            throw new Error(`Bone "${bone_data.name}" not found.`);
          }

          const axis = bone_data.mirror_axis || "x";
          const mirroredBone = bone.duplicate();

          // Mirror position
          const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
          mirroredBone.origin[axisIndex] *= -1;

          // Update name
          mirroredBone.name = bone.name.includes("left")
            ? bone.name.replace("left", "right")
            : bone.name.includes("right")
            ? bone.name.replace("right", "left")
            : bone.name + "_mirrored";

          result = `Mirrored bone "${bone_data.name}" across ${axis} axis`;
          break;
        }
      }

      Undo.finishEdit(`Bone rigging: ${action}`);
      Canvas.updateAll();

      return result;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "animation_timeline",
  {
    description:
      "Controls the animation timeline, including playback, time scrubbing, and timeline settings.",
    annotations: {
      title: "Animation Timeline",
      destructiveHint: true,
    },
    parameters: z.object({
      action: z
        .enum([
          "play",
          "pause",
          "stop",
          "set_time",
          "set_length",
          "set_fps",
          "loop",
          "select_range",
        ])
        .describe("Timeline action to perform."),
      time: z
        .number()
        .optional()
        .describe("Time in seconds (for set_time action)."),
      length: z
        .number()
        .optional()
        .describe("Animation length in seconds (for set_length action)."),
      fps: z
        .number()
        .min(1)
        .max(120)
        .optional()
        .describe("Frames per second (for set_fps action)."),
      loop_mode: z
        .enum(["once", "loop", "hold"])
        .optional()
        .describe("Loop mode for the animation."),
      range: z
        .object({
          start: z.number(),
          end: z.number(),
        })
        .optional()
        .describe("Time range for selection."),
    }),
    async execute({ action, time, length, fps, loop_mode, range }) {
      if (!Animation.selected) {
        throw new Error("No animation selected.");
      }

      let result = "";

      switch (action) {
        case "play":
          Timeline.start();
          result = "Started animation playback";
          break;

        case "pause":
          Timeline.pause();
          result = "Paused animation playback";
          break;

        case "stop":
          Timeline.setTime(0);
          Timeline.pause();
          result = "Stopped animation playback";
          break;

        case "set_time":
          if (time === undefined) {
            throw new Error("Time parameter required for set_time action.");
          }
          Timeline.setTime(time);
          result = `Set timeline to ${time} seconds`;
          break;

        case "set_length":
          if (length === undefined) {
            throw new Error("Length parameter required for set_length action.");
          }
          Animation.selected.length = length;
          result = `Set animation length to ${length} seconds`;
          break;

        case "set_fps":
          if (fps === undefined) {
            throw new Error("FPS parameter required for set_fps action.");
          }
          Animation.selected.snapping = fps;
          result = `Set animation FPS to ${fps}`;
          break;

        case "loop":
          if (loop_mode) {
            Animation.selected.loop = loop_mode;
          }
          result = `Set loop mode to ${loop_mode || Animation.selected.loop}`;
          break;

        case "select_range":
          if (!range) {
            throw new Error(
              "Range parameter required for select_range action."
            );
          }
          // Select keyframes in range
          Timeline.keyframes.forEach((kf) => {
            if (kf.time >= range.start && kf.time <= range.end) {
              kf.select();
            } else {
              kf.selected = false;
            }
          });
          result = `Selected keyframes between ${range.start} and ${range.end} seconds`;
          break;
      }

      Animator.preview();

      return result;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "batch_keyframe_operations",
  {
    description: "Performs batch operations on multiple keyframes at once.",
    annotations: {
      title: "Batch Keyframe Operations",
      destructiveHint: true,
    },
    parameters: z.object({
      selection: z
        .enum(["all", "selected", "range", "pattern"])
        .default("selected")
        .describe("Which keyframes to operate on."),
      range: z
        .object({
          start: z.number(),
          end: z.number(),
        })
        .optional()
        .describe("Time range for keyframe selection."),
      pattern: z
        .object({
          interval: z.number().describe("Time interval between keyframes."),
          offset: z
            .number()
            .optional()
            .default(0)
            .describe("Time offset for the pattern."),
        })
        .optional()
        .describe("Pattern-based selection."),
      operation: z
        .enum(["offset", "scale", "reverse", "mirror", "smooth", "bake"])
        .describe("Operation to perform on keyframes."),
      parameters: z
        .object({
          offset_time: z.number().optional().describe("Time offset to apply."),
          offset_values: z
            .tuple([z.number(), z.number(), z.number()])
            .optional()
            .describe("Value offset to apply."),
          scale_factor: z
            .number()
            .optional()
            .describe("Scale factor for time or values."),
          scale_pivot: z
            .number()
            .optional()
            .describe("Pivot point for scaling."),
          mirror_axis: z
            .enum(["x", "y", "z"])
            .optional()
            .describe("Axis to mirror values across."),
          bake_interval: z
            .number()
            .optional()
            .describe("Interval for baking keyframes."),
        })
        .optional()
        .describe("Operation-specific parameters."),
    }),
    async execute({ selection, range, pattern, operation, parameters = {} }) {
      if (!Animation.selected) {
        throw new Error("No animation selected.");
      }

      // Gather keyframes based on selection type
      let keyframes: any[] = [];

      switch (selection) {
        case "all":
          keyframes = Timeline.keyframes;
          break;

        case "selected":
          keyframes = Timeline.selected;
          break;

        case "range":
          if (!range) {
            throw new Error("Range required for range selection.");
          }
          keyframes = Timeline.keyframes.filter(
            (kf) => kf.time >= range.start && kf.time <= range.end
          );
          break;

        case "pattern":
          if (!pattern) {
            throw new Error("Pattern required for pattern selection.");
          }
          keyframes = Timeline.keyframes.filter((kf) => {
            const relativeTime = kf.time - pattern.offset;
            return Math.abs(relativeTime % pattern.interval) < 0.001;
          });
          break;
      }

      if (keyframes.length === 0) {
        throw new Error("No keyframes found matching selection criteria.");
      }

      Undo.initEdit({
        keyframes: keyframes,
      });

      switch (operation) {
        case "offset":
          keyframes.forEach((kf) => {
            if (parameters.offset_time !== undefined) {
              kf.time += parameters.offset_time;
            }
            if (parameters.offset_values) {
              const values = kf.getArray();
              kf.set("values", [
                values[0] + parameters.offset_values[0],
                values[1] + parameters.offset_values[1],
                values[2] + parameters.offset_values[2],
              ]);
            }
          });
          break;

        case "scale":
          const pivot = parameters.scale_pivot || 0;
          const factor = parameters.scale_factor || 1;
          keyframes.forEach((kf) => {
            kf.time = pivot + (kf.time - pivot) * factor;
          });
          break;

        case "reverse":
          const times = keyframes.map((kf) => kf.time);
          const minTime = Math.min(...times);
          const maxTime = Math.max(...times);
          keyframes.forEach((kf) => {
            kf.time = maxTime - (kf.time - minTime);
          });
          break;

        case "mirror":
          if (!parameters.mirror_axis) {
            throw new Error("Mirror axis required for mirror operation.");
          }
          const axisIndex =
            parameters.mirror_axis === "x"
              ? 0
              : parameters.mirror_axis === "y"
              ? 1
              : 2;
          keyframes.forEach((kf) => {
            const values = kf.getArray();
            values[axisIndex] *= -1;
            kf.set("values", values);
          });
          break;

        case "smooth":
          // Apply catmullrom interpolation to all keyframes
          keyframes.forEach((kf) => {
            kf.interpolation = "catmullrom";
          });
          break;

        case "bake":
          const interval =
            parameters.bake_interval || 1 / Animation.selected.snapping;
          const animators = new Set(keyframes.map((kf) => kf.animator));

          animators.forEach((animator) => {
            const channels = ["rotation", "position", "scale"];
            channels.forEach((channel) => {
              const channelKfs = animator[channel];
              if (!channelKfs || channelKfs.length < 2) return;

              const startTime = Math.min(...channelKfs.map((kf) => kf.time));
              const endTime = Math.max(...channelKfs.map((kf) => kf.time));

              for (let time = startTime; time <= endTime; time += interval) {
                if (
                  !channelKfs.find((kf) => Math.abs(kf.time - time) < 0.001)
                ) {
                  Timeline.time = time;
                  animator.fillValues(
                    animator.createKeyframe(
                      {
                        time,
                        channel,
                        values: animator.interpolate(channel, true),
                      },
                      time,
                      channel,
                      false
                    ),
                    null,
                    false
                  );
                }
              }
            });
          });
          break;
      }

      Undo.finishEdit(`Batch keyframe operation: ${operation}`);
      Animator.preview();

      return `Performed ${operation} on ${keyframes.length} keyframes`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "animation_copy_paste",
  {
    description:
      "Copies and pastes animation data between bones or animations.",
    annotations: {
      title: "Animation Copy/Paste",
      destructiveHint: true,
    },
    parameters: z.object({
      action: z
        .enum(["copy", "paste", "mirror_paste"])
        .describe("Copy or paste action."),
      source: z
        .object({
          animation: z
            .string()
            .optional()
            .describe("Source animation name or UUID."),
          bone: z.string().describe("Source bone name."),
          channels: z
            .array(z.enum(["rotation", "position", "scale"]))
            .optional()
            .default(["rotation", "position", "scale"])
            .describe("Channels to copy."),
          time_range: z
            .object({
              start: z.number(),
              end: z.number(),
            })
            .optional()
            .describe(
              "Time range to copy. If not provided, copies all keyframes."
            ),
        })
        .optional()
        .describe("Source data for copy operation."),
      target: z
        .object({
          animation: z
            .string()
            .optional()
            .describe("Target animation name or UUID."),
          bone: z.string().describe("Target bone name."),
          time_offset: z
            .number()
            .optional()
            .default(0)
            .describe("Time offset for pasted keyframes."),
          mirror_axis: z
            .enum(["x", "y", "z"])
            .optional()
            .describe("Axis to mirror across for mirror_paste."),
        })
        .optional()
        .describe("Target data for paste operation."),
    }),
    async execute({ action, source, target }) {
      // Static storage for copied data between copy/paste operations
      // @ts-ignore
      if (!global.animationClipboard) {
        // @ts-ignore
        global.animationClipboard = null;
      }

      switch (action) {
        case "copy": {
          if (!source) {
            throw new Error("Source data required for copy operation.");
          }

          const srcAnimation = source.animation
            ? Animation.all.find(
                (a) =>
                  a.uuid === source.animation || a.name === source.animation
              )
            : Animation.selected;

          if (!srcAnimation) {
            throw new Error("Source animation not found.");
          }

          const srcBone = Group.all.find((g) => g.name === source.bone);
          if (!srcBone) {
            throw new Error(`Source bone "${source.bone}" not found.`);
          }

          const animator = srcAnimation.animators[srcBone.uuid];
          if (!animator) {
            throw new Error(`No animation data for bone "${source.bone}".`);
          }

          // Copy keyframe data
          const copiedData: any = {
            bone_name: source.bone,
            channels: {},
          };

          source.channels.forEach((channel) => {
            if (!animator[channel]) return;

            let keyframes = animator[channel];
            if (source.time_range) {
              keyframes = keyframes.filter(
                (kf) =>
                  kf.time >= source.time_range.start &&
                  kf.time <= source.time_range.end
              );
            }

            copiedData.channels[channel] = keyframes.map((kf) => ({
              time: kf.time,
              values: kf.getArray(),
              interpolation: kf.interpolation,
              // @ts-ignore
              bezier_left_time: kf.bezier_left_time,
              // @ts-ignore
              bezier_left_value: kf.bezier_left_value,
              // @ts-ignore
              bezier_right_time: kf.bezier_right_time,
              // @ts-ignore
              bezier_right_value: kf.bezier_right_value,
            }));
          });

          // @ts-ignore
          global.animationClipboard = copiedData;

          return `Copied animation data from "${source.bone}" (${Object.keys(
            copiedData.channels
          ).join(", ")})`;
        }

        case "paste":
        case "mirror_paste": {
          if (!target) {
            throw new Error("Target data required for paste operation.");
          }

          // @ts-ignore
          if (!global.animationClipboard) {
            throw new Error("No animation data in clipboard. Copy first.");
          }

          const tgtAnimation = target.animation
            ? Animation.all.find(
                (a) =>
                  a.uuid === target.animation || a.name === target.animation
              )
            : Animation.selected;

          if (!tgtAnimation) {
            throw new Error("Target animation not found.");
          }

          const tgtBone = Group.all.find((g) => g.name === target.bone);
          if (!tgtBone) {
            throw new Error(`Target bone "${target.bone}" not found.`);
          }

          let animator = tgtAnimation.animators[tgtBone.uuid];
          if (!animator) {
            animator = new BoneAnimator(
              tgtBone.uuid,
              tgtAnimation,
              target.bone
            );
            tgtAnimation.animators[tgtBone.uuid] = animator;
          }

          Undo.initEdit({
            animations: [tgtAnimation],
            keyframes: [],
          });

          // @ts-ignore
          const clipboardData = global.animationClipboard;
          const mirrorAxis =
            action === "mirror_paste" ? target.mirror_axis || "x" : null;
          const axisIndex =
            mirrorAxis === "x"
              ? 0
              : mirrorAxis === "y"
              ? 1
              : mirrorAxis === "z"
              ? 2
              : -1;

          Object.entries(clipboardData.channels).forEach(
            ([channel, keyframes]: [string, any[]]) => {
              keyframes.forEach((kfData) => {
                const values = [...kfData.values];

                // Apply mirroring if needed
                if (
                  mirrorAxis &&
                  (channel === "rotation" || channel === "position")
                ) {
                  values[axisIndex] *= -1;
                }

                const keyframe = animator.createKeyframe(
                  {
                    time: kfData.time + (target.time_offset || 0),
                    channel,
                    values,
                    interpolation: kfData.interpolation,
                  },
                  kfData.time + (target.time_offset || 0),
                  channel,
                  false
                );

                // Copy bezier data if present
                if (kfData.interpolation === "bezier") {
                  // @ts-ignore
                  if (kfData.bezier_left_time !== undefined)
                    keyframe.bezier_left_time = kfData.bezier_left_time;
                  // @ts-ignore
                  if (kfData.bezier_left_value)
                    keyframe.bezier_left_value = kfData.bezier_left_value;
                  // @ts-ignore
                  if (kfData.bezier_right_time !== undefined)
                    keyframe.bezier_right_time = kfData.bezier_right_time;
                  // @ts-ignore
                  if (kfData.bezier_right_value)
                    keyframe.bezier_right_value = kfData.bezier_right_value;
                }
              });
            }
          );

          Undo.finishEdit(`${action} animation data`);
          Animator.preview();

          return `Pasted animation data to "${target.bone}"${
            mirrorAxis ? ` (mirrored on ${mirrorAxis} axis)` : ""
          }`;
        }
      }
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "create_sphere",
  {
    description:
      "Creates a sphere mesh at the specified position with the given parameters. The sphere is created as a mesh with vertices and faces using spherical coordinates.",
    annotations: {
      title: "Create Sphere",
      destructiveHint: true,
    },
    parameters: z.object({
      elements: z
        .array(
          z.object({
            name: z.string().describe("Name of the sphere."),
            position: z
              .tuple([z.number(), z.number(), z.number()])
              .describe("Position of the sphere center."),
            diameter: z
              .number()
              .min(1)
              .max(64)
              .default(16)
              .describe("Diameter of the sphere."),
            sides: z
              .number()
              .min(3)
              .max(48)
              .default(12)
              .describe(
                "Number of horizontal divisions (affects sphere quality)."
              ),
            rotation: z
              .tuple([z.number(), z.number(), z.number()])
              .optional()
              .default([0, 0, 0])
              .describe("Rotation of the sphere."),
            align_edges: z
              .boolean()
              .optional()
              .default(true)
              .describe("Whether to align edges for better geometry."),
          })
        )
        .min(1)
        .describe("Array of spheres to create."),
      texture: z
        .string()
        .optional()
        .describe("Texture ID or name to apply to the sphere."),
      group: z
        .string()
        .optional()
        .describe("Group/bone to which the sphere belongs."),
    }),
    async execute({ elements, texture, group }, { reportProgress }) {
      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
      });
      const total = elements.length;

      const projectTexture = texture
        ? getProjectTexture(texture)
        : Texture.getDefault();

      if (!projectTexture) {
        throw new Error(`No texture found for "${texture}".`);
      }

      const groups = getAllGroups();
      const outlinerGroup = groups.find(
        (g) => g.name === group || g.uuid === group
      );

      const spheres = elements.map((element, progress) => {
        const mesh = new Mesh({
          name: element.name,
          vertices: {},
          origin: element.position,
          rotation: element.rotation || [0, 0, 0],
        }).init();

        // Create sphere vertices using spherical coordinates
        const radius = element.diameter / 2;
        const sides = Math.round(element.sides / 2) * 2; // Ensure even number for symmetry

        // Add top and bottom vertices
        const [bottom] = mesh.addVertices([0, -radius, 0]);
        const [top] = mesh.addVertices([0, radius, 0]);

        const rings = [];
        const off_ang = element.align_edges ? 0.5 : 0;

        // Create rings of vertices
        for (let i = 0; i < element.sides; i++) {
          const circle_x = Math.sin(
            ((i + off_ang) / element.sides) * Math.PI * 2
          );
          const circle_z = Math.cos(
            ((i + off_ang) / element.sides) * Math.PI * 2
          );

          const vertices = [];
          for (let j = 1; j < sides / 2; j++) {
            const slice_x = Math.sin((j / sides) * Math.PI * 2) * radius;
            const x = circle_x * slice_x;
            const y = Math.cos((j / sides) * Math.PI * 2) * radius;
            const z = circle_z * slice_x;
            vertices.push(...mesh.addVertices([x, y, z]));
          }
          rings.push(vertices);
        }

        // Create faces
        for (let i = 0; i < element.sides; i++) {
          const this_ring = rings[i];
          const next_ring = rings[i + 1] || rings[0];

          for (let j = 0; j < sides / 2; j++) {
            if (j == 0) {
              // Connect to top vertex
              mesh.addFaces(
                new MeshFace(mesh, {
                  vertices: [this_ring[j], next_ring[j], top],
                  uv: {},
                })
              );
              continue;
            }

            if (!this_ring[j]) {
              // Connect to bottom vertex
              mesh.addFaces(
                new MeshFace(mesh, {
                  vertices: [next_ring[j - 1], this_ring[j - 1], bottom],
                  uv: {},
                })
              );
              continue;
            }

            // Connect ring segments
            mesh.addFaces(
              new MeshFace(mesh, {
                vertices: [
                  this_ring[j],
                  next_ring[j],
                  this_ring[j - 1],
                  next_ring[j - 1],
                ],
                uv: {},
              })
            );
          }
        }

        mesh.addTo(outlinerGroup);
        if (projectTexture) {
          mesh.applyTexture(projectTexture);
        }

        reportProgress({
          progress,
          total,
        });

        return mesh;
      });

      Undo.finishEdit("Agent created spheres");
      Canvas.updateAll();

      return await Promise.resolve(
        JSON.stringify(
          spheres.map(
            (sphere) => `Added sphere ${sphere.name} with ID ${sphere.uuid}`
          )
        )
      );
    },
  },
  STATUS_STABLE
);

createTool(
  "select_mesh_elements",
  {
    description:
      "Selects vertices, edges, or faces of a mesh for manipulation.",
    annotations: {
      title: "Select Mesh Elements",
      destructiveHint: true,
    },
    parameters: z.object({
      mesh_id: z
        .string()
        .describe("ID or name of the mesh to select elements from."),
      mode: z.enum(["vertex", "edge", "face"]).describe("Selection mode."),
      elements: z
        .array(
          z.union([
            z
              .string()
              .describe("Vertex key, edge as 'vkey1-vkey2', or face key"),
            z.number().describe("Index of the element"),
          ])
        )
        .optional()
        .describe("Specific elements to select. If not provided, selects all."),
      action: z
        .enum(["select", "add", "remove", "toggle"])
        .default("select")
        .describe(
          "Selection action: select (replace), add, remove, or toggle."
        ),
    }),
    async execute({ mesh_id, mode, elements, action }) {
      const mesh = Mesh.all.find(
        (m) => m.uuid === mesh_id || m.name === mesh_id
      );
      if (!mesh) {
        throw new Error(`Mesh with ID "${mesh_id}" not found.`);
      }

      Undo.initEdit({
        elements: [mesh],
        selection: true,
      });

      // Set selection mode
      BarItems.selection_mode.set(mode);

      const selection = Project.mesh_selection[mesh.uuid];
      if (!selection) {
        Project.mesh_selection[mesh.uuid] = {
          vertices: [],
          edges: [],
          faces: [],
        };
      }

      if (action === "select") {
        // Clear existing selection
        selection.vertices = [];
        selection.edges = [];
        selection.faces = [];
      }

      if (!elements || elements.length === 0) {
        // Select all elements of the specified type
        if (mode === "vertex") {
          selection.vertices = Object.keys(mesh.vertices);
        } else if (mode === "face") {
          selection.faces = Object.keys(mesh.faces);
        } else if (mode === "edge") {
          // @ts-ignore
          selection.edges = mesh.getEdges();
        }
      } else {
        // Select specific elements
        elements.forEach((element) => {
          if (mode === "vertex") {
            const vkey = String(element);
            if (action === "add" || action === "select") {
              selection.vertices.safePush(vkey);
            } else if (action === "remove") {
              selection.vertices.remove(vkey);
            } else if (action === "toggle") {
              selection.vertices.toggle(vkey);
            }
          } else if (mode === "face") {
            const fkey = String(element);
            if (action === "add" || action === "select") {
              selection.faces.safePush(fkey);
            } else if (action === "remove") {
              selection.faces.remove(fkey);
            } else if (action === "toggle") {
              selection.faces.toggle(fkey);
            }
          } else if (mode === "edge") {
            // Parse edge format "vkey1-vkey2"
            const edgeParts = String(element).split("-");
            if (edgeParts.length === 2) {
              const edge = [edgeParts[0], edgeParts[1]];
              if (action === "add" || action === "select") {
                selection.edges.push(edge);
              } else if (action === "remove") {
                selection.edges = selection.edges.filter(
                  (e) =>
                    !(e[0] === edge[0] && e[1] === edge[1]) &&
                    !(e[0] === edge[1] && e[1] === edge[0])
                );
              }
            }
          }
        });
      }

      mesh.select();
      Canvas.updateView({
        elements: [mesh],
        selection: true,
      });

      Undo.finishEdit("Select mesh elements");

      return JSON.stringify({
        mesh: mesh.name,
        mode,
        selected: {
          vertices: selection.vertices.length,
          edges: selection.edges.length,
          faces: selection.faces.length,
        },
      });
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "move_mesh_vertices",
  {
    description: "Moves selected vertices of a mesh by the specified offset.",
    annotations: {
      title: "Move Mesh Vertices",
      destructiveHint: true,
    },
    parameters: z.object({
      mesh_id: z
        .string()
        .optional()
        .describe(
          "ID or name of the mesh. If not provided, uses selected mesh."
        ),
      offset: z
        .tuple([z.number(), z.number(), z.number()])
        .describe("Offset to move vertices by [x, y, z]."),
      vertices: z
        .array(z.string())
        .optional()
        .describe(
          "Specific vertex keys to move. If not provided, moves all selected vertices."
        ),
    }),
    async execute({ mesh_id, offset, vertices }) {
      const mesh = mesh_id
        ? Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id)
        : Mesh.selected[0];

      if (!mesh) {
        throw new Error(
          mesh_id ? `Mesh with ID "${mesh_id}" not found.` : "No mesh selected."
        );
      }

      Undo.initEdit({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      const verticesToMove = vertices || mesh.getSelectedVertices();

      verticesToMove.forEach((vkey) => {
        if (mesh.vertices[vkey]) {
          mesh.vertices[vkey][0] += offset[0];
          mesh.vertices[vkey][1] += offset[1];
          mesh.vertices[vkey][2] += offset[2];
        }
      });

      mesh.preview_controller.updateGeometry(mesh);

      Undo.finishEdit("Move mesh vertices");
      Canvas.updateView({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      return `Moved ${verticesToMove.length} vertices of mesh "${mesh.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "extrude_mesh",
  {
    description: "Extrudes selected faces or edges of a mesh.",
    annotations: {
      title: "Extrude Mesh",
      destructiveHint: true,
    },
    parameters: z.object({
      mesh_id: z
        .string()
        .optional()
        .describe(
          "ID or name of the mesh. If not provided, uses selected mesh."
        ),
      distance: z.number().default(1).describe("Distance to extrude."),
      mode: z
        .enum(["faces", "edges", "vertices"])
        .default("faces")
        .describe("What to extrude: faces, edges, or vertices."),
    }),
    async execute({ mesh_id, distance, mode }) {
      const mesh = mesh_id
        ? Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id)
        : Mesh.selected[0];

      if (!mesh) {
        throw new Error(
          mesh_id ? `Mesh with ID "${mesh_id}" not found.` : "No mesh selected."
        );
      }

      // Use the extrude tool
      const tool =
        mode === "faces"
          ? BarItems.extrude_mesh_selection
          : mode === "edges"
          ? BarItems.extrude_mesh_selection
          : BarItems.extrude_mesh_selection;

      if (!tool) {
        throw new Error(`Extrude tool for ${mode} not found.`);
      }

      // @ts-ignore
      tool.click({}, distance);

      return `Extruded ${mode} of mesh "${mesh.name}" by ${distance} units`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "subdivide_mesh",
  {
    description: "Subdivides selected faces of a mesh to create more geometry.",
    annotations: {
      title: "Subdivide Mesh",
      destructiveHint: true,
    },
    parameters: z.object({
      mesh_id: z
        .string()
        .optional()
        .describe(
          "ID or name of the mesh. If not provided, uses selected mesh."
        ),
      cuts: z
        .number()
        .min(1)
        .max(10)
        .default(1)
        .describe("Number of subdivision cuts to make."),
    }),
    async execute({ mesh_id, cuts }) {
      const mesh = mesh_id
        ? Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id)
        : Mesh.selected[0];

      if (!mesh) {
        throw new Error(
          mesh_id ? `Mesh with ID "${mesh_id}" not found.` : "No mesh selected."
        );
      }

      // Use the loop cut tool with subdivision
      const tool = BarItems.loop_cut;
      if (!tool) {
        throw new Error("Loop cut tool not found.");
      }

      // @ts-ignore
      tool.click({}, undefined, undefined, cuts);

      return `Subdivided mesh "${mesh.name}" with ${cuts} cuts`;
    },
  },
  STATUS_EXPERIMENTAL
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
              .tuple([z.number(), z.number(), z.number()])
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

createTool(
  "set_mesh_uv",
  {
    description: "Sets UV coordinates for mesh faces or vertices.",
    annotations: {
      title: "Set Mesh UV",
      destructiveHint: true,
    },
    parameters: z.object({
      mesh_id: z.string().describe("ID or name of the mesh."),
      face_key: z.string().describe("Face key to set UV for."),
      uv_mapping: z
        .record(
          z.string(), // vertex key
          z.tuple([z.number(), z.number()]) // UV coordinates
        )
        .describe("UV coordinates for each vertex of the face."),
    }),
    async execute({ mesh_id, face_key, uv_mapping }) {
      const mesh = Mesh.all.find(
        (m) => m.uuid === mesh_id || m.name === mesh_id
      );
      if (!mesh) {
        throw new Error(`Mesh with ID "${mesh_id}" not found.`);
      }

      Undo.initEdit({
        elements: [mesh],
        uv_only: true,
      });

      const face = mesh.faces[face_key];
      if (!face) {
        throw new Error(`Face with key "${face_key}" not found in mesh.`);
      }

      // Set UV coordinates for each vertex
      Object.entries(uv_mapping).forEach(([vkey, uv]) => {
        if (face.vertices.includes(vkey)) {
          face.uv[vkey] = uv;
        }
      });

      mesh.preview_controller.updateUV(mesh);
      UVEditor.loadData();

      Undo.finishEdit("Set mesh UV");

      return `Set UV mapping for face "${face_key}" of mesh "${mesh.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "auto_uv_mesh",
  {
    description: "Automatically generates UV mapping for selected mesh faces.",
    annotations: {
      title: "Auto UV Mesh",
      destructiveHint: true,
    },
    parameters: z.object({
      mesh_id: z
        .string()
        .optional()
        .describe(
          "ID or name of the mesh. If not provided, uses selected mesh."
        ),
      mode: z
        .enum(["project", "unwrap", "cylinder", "sphere"])
        .default("project")
        .describe(
          "UV mapping mode: project from view, unwrap, cylinder, or sphere mapping."
        ),
      faces: z
        .array(z.string())
        .optional()
        .describe(
          "Specific face keys to UV map. If not provided, maps all selected faces."
        ),
    }),
    async execute({ mesh_id, mode, faces }) {
      const mesh = mesh_id
        ? Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id)
        : Mesh.selected[0];

      if (!mesh) {
        throw new Error(
          mesh_id ? `Mesh with ID "${mesh_id}" not found.` : "No mesh selected."
        );
      }

      Undo.initEdit({
        elements: [mesh],
        uv_only: true,
      });

      const selectedFaces = faces || UVEditor.getSelectedFaces(mesh);

      if (mode === "project") {
        // Use project from view
        BarItems.uv_project_from_view.click();
      } else {
        // Manual UV mapping based on mode
        selectedFaces.forEach((fkey) => {
          const face = mesh.faces[fkey];
          if (!face) return;

          if (mode === "unwrap") {
            // Simple planar unwrap
            UVEditor.setAutoSize(null, true, [fkey]);
          } else if (mode === "cylinder") {
            // Cylindrical mapping
            const vertices = face.getSortedVertices();
            vertices.forEach((vkey, i) => {
              const vertex = mesh.vertices[vkey];
              const angle = Math.atan2(vertex[0], vertex[2]);
              const u =
                ((angle + Math.PI) / (2 * Math.PI)) * Project.texture_width;
              const v = ((vertex[1] + 8) / 16) * Project.texture_height;
              face.uv[vkey] = [u, v];
            });
          } else if (mode === "sphere") {
            // Spherical mapping
            const vertices = face.getSortedVertices();
            vertices.forEach((vkey) => {
              const vertex = mesh.vertices[vkey];
              const length = Math.sqrt(
                vertex[0] ** 2 + vertex[1] ** 2 + vertex[2] ** 2
              );
              const theta = Math.acos(vertex[1] / length);
              const phi = Math.atan2(vertex[0], vertex[2]);
              const u =
                ((phi + Math.PI) / (2 * Math.PI)) * Project.texture_width;
              const v = (theta / Math.PI) * Project.texture_height;
              face.uv[vkey] = [u, v];
            });
          }
        });
      }

      mesh.preview_controller.updateUV(mesh);
      UVEditor.loadData();

      Undo.finishEdit("Auto UV mesh");

      return `Applied ${mode} UV mapping to ${selectedFaces.length} faces of mesh "${mesh.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "rotate_mesh_uv",
  {
    description: "Rotates UV coordinates of selected mesh faces.",
    annotations: {
      title: "Rotate Mesh UV",
      destructiveHint: true,
    },
    parameters: z.object({
      mesh_id: z
        .string()
        .optional()
        .describe(
          "ID or name of the mesh. If not provided, uses selected mesh."
        ),
      angle: z
        .enum(["-90", "90", "180"])
        .default("90")
        .describe("Rotation angle in degrees."),
      faces: z
        .array(z.string())
        .optional()
        .describe(
          "Specific face keys to rotate UV for. If not provided, rotates all selected faces."
        ),
    }),
    async execute({ mesh_id, angle, faces }) {
      const mesh = mesh_id
        ? Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id)
        : Mesh.selected[0];

      if (!mesh) {
        throw new Error(
          mesh_id ? `Mesh with ID "${mesh_id}" not found.` : "No mesh selected."
        );
      }

      Undo.initEdit({
        elements: [mesh],
        uv_only: true,
      });

      const rotation = parseInt(angle);
      UVEditor.rotate(rotation);

      Undo.finishEdit("Rotate mesh UV");

      return `Rotated UV by ${angle} degrees for mesh "${mesh.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "merge_mesh_vertices",
  {
    description:
      "Merges vertices that are within a specified distance of each other.",
    annotations: {
      title: "Merge Mesh Vertices",
      destructiveHint: true,
    },
    parameters: z.object({
      mesh_id: z.string().describe("ID or name of the mesh."),
      threshold: z
        .number()
        .min(0)
        .max(10)
        .default(0.1)
        .describe("Maximum distance between vertices to merge."),
      selected_only: z
        .boolean()
        .default(true)
        .describe("Whether to only merge selected vertices."),
    }),
    async execute({ mesh_id, threshold, selected_only }) {
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

      const verticesToCheck = selected_only
        ? mesh.getSelectedVertices()
        : Object.keys(mesh.vertices);

      let mergedCount = 0;
      const mergeMap: Record<string, string> = {};

      // Find vertices to merge
      for (let i = 0; i < verticesToCheck.length; i++) {
        const vkey1 = verticesToCheck[i];
        if (mergeMap[vkey1]) continue;

        for (let j = i + 1; j < verticesToCheck.length; j++) {
          const vkey2 = verticesToCheck[j];
          if (mergeMap[vkey2]) continue;

          const v1 = mesh.vertices[vkey1];
          const v2 = mesh.vertices[vkey2];
          const distance = Math.sqrt(
            (v1[0] - v2[0]) ** 2 + (v1[1] - v2[1]) ** 2 + (v1[2] - v2[2]) ** 2
          );

          if (distance <= threshold) {
            mergeMap[vkey2] = vkey1;
            mergedCount++;
          }
        }
      }

      // Apply merges
      Object.entries(mergeMap).forEach(([oldKey, newKey]) => {
        // Update faces
        for (const fkey in mesh.faces) {
          const face = mesh.faces[fkey];
          const index = face.vertices.indexOf(oldKey);
          if (index !== -1) {
            face.vertices[index] = newKey;
            face.uv[newKey] = face.uv[oldKey] || [0, 0];
            delete face.uv[oldKey];
          }
        }
        // Remove merged vertex
        delete mesh.vertices[oldKey];
      });

      mesh.preview_controller.updateGeometry(mesh);

      Undo.finishEdit("Merge mesh vertices");
      Canvas.updateView({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      return `Merged ${mergedCount} vertices in mesh "${mesh.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "create_mesh_face",
  {
    description: "Creates a new face from selected vertices.",
    annotations: {
      title: "Create Mesh Face",
      destructiveHint: true,
    },
    parameters: z.object({
      mesh_id: z
        .string()
        .optional()
        .describe(
          "ID or name of the mesh. If not provided, uses selected mesh."
        ),
      vertices: z
        .array(z.string())
        .min(3)
        .max(4)
        .describe("Vertex keys to create face from. Must be 3 or 4 vertices."),
      texture: z
        .string()
        .optional()
        .describe("Texture ID or name to apply to the new face."),
    }),
    async execute({ mesh_id, vertices, texture }) {
      const mesh = mesh_id
        ? Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id)
        : Mesh.selected[0];

      if (!mesh) {
        throw new Error(
          mesh_id ? `Mesh with ID "${mesh_id}" not found.` : "No mesh selected."
        );
      }

      Undo.initEdit({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      // Create the face
      const face = new MeshFace(mesh, {
        vertices,
        texture: texture ? getProjectTexture(texture)?.uuid : undefined,
      });

      const [faceKey] = mesh.addFaces(face);

      // Auto UV the new face
      UVEditor.setAutoSize(null, true, [faceKey]);

      mesh.preview_controller.updateGeometry(mesh);
      mesh.preview_controller.updateUV(mesh);

      Undo.finishEdit("Create mesh face");
      Canvas.updateView({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      return `Created face with ${vertices.length} vertices in mesh "${mesh.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "delete_mesh_elements",
  {
    description: "Deletes selected vertices, edges, or faces from a mesh.",
    annotations: {
      title: "Delete Mesh Elements",
      destructiveHint: true,
    },
    parameters: z.object({
      mesh_id: z
        .string()
        .optional()
        .describe(
          "ID or name of the mesh. If not provided, uses selected mesh."
        ),
      mode: z
        .enum(["vertices", "edges", "faces"])
        .default("faces")
        .describe("What to delete: vertices, edges, or faces."),
      keep_vertices: z
        .boolean()
        .default(false)
        .describe("When deleting faces/edges, whether to keep the vertices."),
    }),
    async execute({ mesh_id, mode, keep_vertices }) {
      const mesh = mesh_id
        ? Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id)
        : Mesh.selected[0];

      if (!mesh) {
        throw new Error(
          mesh_id ? `Mesh with ID "${mesh_id}" not found.` : "No mesh selected."
        );
      }

      // Use the delete tool
      const tool = BarItems.delete_mesh_selection;
      if (!tool) {
        throw new Error("Delete mesh selection tool not found.");
      }

      // @ts-ignore
      tool.click({}, keep_vertices);

      return `Deleted selected ${mode} from mesh "${mesh.name}"`;
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
  "paint_fill_tool",
  {
    description: "Uses the fill/bucket tool to fill areas with color.",
    annotations: {
      title: "Paint Fill Tool",
      destructiveHint: true,
    },
    parameters: z.object({
      texture_id: z
        .string()
        .optional()
        .describe(
          "Texture ID or name. If not provided, uses selected texture."
        ),
      x: z.number().describe("X coordinate to start fill."),
      y: z.number().describe("Y coordinate to start fill."),
      color: z.string().optional().describe("Fill color as hex string."),
      opacity: z
        .number()
        .min(0)
        .max(255)
        .optional()
        .describe("Fill opacity (0-255)."),
      tolerance: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Color tolerance for fill."),
      fill_mode: z
        .enum([
          "color",
          "color_connected",
          "face",
          "element",
          "selected_elements",
          "selection",
        ])
        .optional()
        .default("color_connected")
        .describe("Fill mode."),
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
        .describe("Fill blend mode."),
    }),
    async execute({
      texture_id,
      x,
      y,
      color,
      opacity,
      tolerance,
      fill_mode,
      blend_mode,
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
        bitmap: true,
      });

      // Apply settings
      if (color) {
        ColorPanel.set(color);
      }
      if (opacity !== undefined) {
        // @ts-ignore
        BarItems.slider_brush_opacity.set(opacity);
      }
      if (fill_mode) {
        // @ts-ignore
        BarItems.fill_mode.set(fill_mode);
      }
      if (blend_mode) {
        // @ts-ignore
        BarItems.blend_mode.set(blend_mode);
      }

      // Select fill tool
      // @ts-ignore
      BarItems.fill_tool.select();

      // Perform fill
      Painter.startPaintTool(texture, x, y);
      Painter.stopPaintTool();

      Undo.finishEdit("Fill tool");
      Canvas.updateAll();

      return `Filled area at (${x}, ${y}) on texture "${texture.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "draw_shape_tool",
  {
    description: "Draws geometric shapes on textures.",
    annotations: {
      title: "Draw Shape Tool",
      destructiveHint: true,
    },
    parameters: z.object({
      texture_id: z
        .string()
        .optional()
        .describe(
          "Texture ID or name. If not provided, uses selected texture."
        ),
      shape: z
        .enum(["rectangle", "rectangle_h", "ellipse", "ellipse_h"])
        .describe("Shape to draw. '_h' suffix means hollow."),
      start: z.object({
        x: z.number().describe("Start X coordinate."),
        y: z.number().describe("Start Y coordinate."),
      }),
      end: z.object({
        x: z.number().describe("End X coordinate."),
        y: z.number().describe("End Y coordinate."),
      }),
      color: z.string().optional().describe("Shape color as hex string."),
      line_width: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Line width for hollow shapes."),
      opacity: z
        .number()
        .min(0)
        .max(255)
        .optional()
        .describe("Shape opacity (0-255)."),
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
        .describe("Shape blend mode."),
    }),
    async execute({
      texture_id,
      shape,
      start,
      end,
      color,
      line_width,
      opacity,
      blend_mode,
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
        bitmap: true,
      });

      // Apply settings
      if (color) {
        ColorPanel.set(color);
      }
      if (opacity !== undefined) {
        // @ts-ignore
        BarItems.slider_brush_opacity.set(opacity);
      }
      if (line_width !== undefined) {
        // @ts-ignore
        BarItems.slider_brush_size.set(line_width);
      }
      if (blend_mode) {
        // @ts-ignore
        BarItems.blend_mode.set(blend_mode);
      }

      // Set shape type
      // @ts-ignore
      BarItems.draw_shape_type.set(shape);

      // Select draw shape tool
      // @ts-ignore
      BarItems.draw_shape_tool.select();

      // Draw shape
      Painter.startPaintTool(texture, start.x, start.y);
      Painter.useShapeTool(texture, end.x, end.y, {});
      Painter.stopPaintTool();

      Undo.finishEdit("Draw shape");
      Canvas.updateAll();

      return `Drew ${shape} from (${start.x}, ${start.y}) to (${end.x}, ${end.y}) on texture "${texture.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "gradient_tool",
  {
    description: "Applies gradients to textures.",
    annotations: {
      title: "Gradient Tool",
      destructiveHint: true,
    },
    parameters: z.object({
      texture_id: z
        .string()
        .optional()
        .describe(
          "Texture ID or name. If not provided, uses selected texture."
        ),
      start: z.object({
        x: z.number().describe("Gradient start X coordinate."),
        y: z.number().describe("Gradient start Y coordinate."),
      }),
      end: z.object({
        x: z.number().describe("Gradient end X coordinate."),
        y: z.number().describe("Gradient end Y coordinate."),
      }),
      start_color: z.string().describe("Start color as hex string."),
      end_color: z.string().describe("End color as hex string."),
      opacity: z
        .number()
        .min(0)
        .max(255)
        .optional()
        .describe("Gradient opacity (0-255)."),
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
        .describe("Gradient blend mode."),
    }),
    async execute({
      texture_id,
      start,
      end,
      start_color,
      end_color,
      opacity,
      blend_mode,
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
        bitmap: true,
      });

      // Apply settings
      ColorPanel.set(start_color);
      // @ts-ignore
      ColorPanel.set(end_color, true); // Set as secondary color

      if (opacity !== undefined) {
        // @ts-ignore
        BarItems.slider_brush_opacity.set(opacity);
      }
      if (blend_mode) {
        // @ts-ignore
        BarItems.blend_mode.set(blend_mode);
      }

      // Select gradient tool
      // @ts-ignore
      BarItems.gradient_tool.select();

      // Apply gradient
      Painter.startPaintTool(texture, start.x, start.y);
      Painter.useGradientTool(texture, end.x, end.y, {});
      Painter.stopPaintTool();

      Undo.finishEdit("Apply gradient");
      Canvas.updateAll();

      return `Applied gradient from (${start.x}, ${start.y}) to (${end.x}, ${end.y}) on texture "${texture.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "color_picker_tool",
  {
    description:
      "Picks colors from textures and sets them as the active color.",
    annotations: {
      title: "Color Picker Tool",
      readOnlyHint: true,
    },
    parameters: z.object({
      texture_id: z
        .string()
        .optional()
        .describe(
          "Texture ID or name. If not provided, uses selected texture."
        ),
      x: z.number().describe("X coordinate to pick color from."),
      y: z.number().describe("Y coordinate to pick color from."),
      set_as_secondary: z
        .boolean()
        .optional()
        .default(false)
        .describe("Set as secondary color instead of primary."),
      pick_opacity: z
        .boolean()
        .optional()
        .default(false)
        .describe("Also pick and apply the pixel's opacity."),
    }),
    async execute({ texture_id, x, y, set_as_secondary, pick_opacity }) {
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

      // Pick color
      Painter.colorPicker(texture, x, y, { button: set_as_secondary ? 2 : 0 });

      // Get the picked color
      const color = ColorPanel.get();

      if (pick_opacity) {
        // Get pixel color with alpha
        const pixelColor = Painter.getPixelColor(texture.ctx, x, y);
        const opacity = Math.floor(pixelColor.getAlpha() * 255);

        // Apply opacity to brush tools
        for (let id in BarItems) {
          const tool = BarItems[id];
          // @ts-ignore
          if (tool.tool_settings && tool.tool_settings.brush_opacity >= 0) {
            // @ts-ignore
            tool.tool_settings.brush_opacity = opacity;
          }
        }

        return `Picked color ${color} with opacity ${opacity} from (${x}, ${y}) on texture "${texture.name}"`;
      }

      return `Picked color ${color} from (${x}, ${y}) on texture "${texture.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "copy_brush_tool",
  {
    description: "Uses the copy/clone brush to copy texture areas.",
    annotations: {
      title: "Copy Brush Tool",
      destructiveHint: true,
    },
    parameters: z.object({
      texture_id: z
        .string()
        .optional()
        .describe(
          "Texture ID or name. If not provided, uses selected texture."
        ),
      source: z.object({
        x: z.number().describe("Source X coordinate to copy from."),
        y: z.number().describe("Source Y coordinate to copy from."),
      }),
      target: z.object({
        x: z.number().describe("Target X coordinate to paste to."),
        y: z.number().describe("Target Y coordinate to paste to."),
      }),
      brush_size: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Copy brush size."),
      opacity: z
        .number()
        .min(0)
        .max(255)
        .optional()
        .describe("Copy opacity (0-255)."),
      mode: z
        .enum(["copy", "sample", "pattern"])
        .optional()
        .default("copy")
        .describe("Copy brush mode."),
    }),
    async execute({ texture_id, source, target, brush_size, opacity, mode }) {
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

      // Apply settings
      if (brush_size !== undefined) {
        // @ts-ignore
        BarItems.slider_brush_size.set(brush_size);
      }
      if (opacity !== undefined) {
        // @ts-ignore
        BarItems.slider_brush_opacity.set(opacity);
      }
      if (mode) {
        // @ts-ignore
        BarItems.copy_brush_mode.set(mode);
      }

      // Select copy brush tool
      // @ts-ignore
      BarItems.copy_brush.select();

      // Set source point (Ctrl+click equivalent)
      Painter.startPaintTool(texture, source.x, source.y, undefined, {
        ctrlOrCmd: true,
      });

      // Apply at target point
      Painter.startPaintTool(texture, target.x, target.y);
      Painter.stopPaintTool();

      Undo.finishEdit("Copy brush");
      Canvas.updateAll();

      return `Copied from (${source.x}, ${source.y}) to (${target.x}, ${target.y}) on texture "${texture.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "eraser_tool",
  {
    description: "Erases parts of textures with customizable settings.",
    annotations: {
      title: "Eraser Tool",
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
            x: z.number().describe("X coordinate to erase at."),
            y: z.number().describe("Y coordinate to erase at."),
          })
        )
        .describe("Array of coordinates to erase at."),
      brush_size: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Eraser brush size."),
      opacity: z
        .number()
        .min(0)
        .max(255)
        .optional()
        .describe("Eraser opacity (0-255)."),
      softness: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Eraser softness percentage."),
      shape: z.enum(["square", "circle"]).optional().describe("Eraser shape."),
      connect_strokes: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to connect erase strokes with lines."),
    }),
    async execute({
      texture_id,
      coordinates,
      brush_size,
      opacity,
      softness,
      shape,
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
        bitmap: true,
      });

      // Apply settings
      if (brush_size !== undefined) {
        // @ts-ignore
        BarItems.slider_brush_size.set(brush_size);
      }
      if (opacity !== undefined) {
        // @ts-ignore
        BarItems.slider_brush_opacity.set(opacity);
      }
      if (softness !== undefined) {
        // @ts-ignore
        BarItems.slider_brush_softness.set(softness);
      }
      if (shape !== undefined) {
        // @ts-ignore
        BarItems.brush_shape.set(shape);
      }

      // Select eraser tool
      // @ts-ignore
      BarItems.eraser.select();

      // Erase at coordinates
      for (let i = 0; i < coordinates.length; i++) {
        const coord = coordinates[i];

        if (i === 0 || !connect_strokes) {
          // Start new stroke
          Painter.startPaintTool(texture, coord.x, coord.y);
        } else {
          // Continue stroke
          Painter.movePaintTool(texture, coord.x, coord.y, {});
        }
      }

      // Finish erasing
      Painter.stopPaintTool();

      Undo.finishEdit("Erase texture");
      Canvas.updateAll();

      return `Erased ${coordinates.length} points on texture "${texture.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "paint_settings",
  {
    description: "Configures paint mode settings and preferences.",
    annotations: {
      title: "Paint Settings",
      destructiveHint: true,
    },
    parameters: z.object({
      mirror_painting: z
        .object({
          enabled: z.boolean().describe("Enable mirror painting."),
          axis: z
            .array(z.enum(["x", "y", "z"]))
            .optional()
            .describe("Mirror axes."),
          texture: z.boolean().optional().describe("Enable texture mirroring."),
          texture_center: z
            .tuple([z.number(), z.number()])
            .optional()
            .describe("Texture mirror center."),
        })
        .optional()
        .describe("Mirror painting settings."),
      lock_alpha: z
        .boolean()
        .optional()
        .describe("Lock alpha channel while painting."),
      pixel_perfect: z
        .boolean()
        .optional()
        .describe("Enable pixel perfect drawing."),
      paint_side_restrict: z
        .boolean()
        .optional()
        .describe("Restrict painting to current face side."),
      color_erase_mode: z
        .boolean()
        .optional()
        .describe("Enable color erase mode."),
      brush_opacity_modifier: z
        .enum(["none", "pressure", "tilt"])
        .optional()
        .describe("Brush opacity modifier for stylus."),
      brush_size_modifier: z
        .enum(["none", "pressure", "tilt"])
        .optional()
        .describe("Brush size modifier for stylus."),
      paint_with_stylus_only: z
        .boolean()
        .optional()
        .describe("Only allow painting with stylus input."),
      pick_color_opacity: z
        .boolean()
        .optional()
        .describe("Pick opacity when using color picker."),
      pick_combined_color: z
        .boolean()
        .optional()
        .describe("Pick combined layer colors."),
    }),
    async execute({
      mirror_painting,
      lock_alpha,
      pixel_perfect,
      paint_side_restrict,
      color_erase_mode,
      brush_opacity_modifier,
      brush_size_modifier,
      paint_with_stylus_only,
      pick_color_opacity,
      pick_combined_color,
    }) {
      const settings: string[] = [];

      // Mirror painting
      if (mirror_painting !== undefined) {
        // @ts-ignore
        BarItems.mirror_painting.set(mirror_painting.enabled);
        Painter.mirror_painting = mirror_painting.enabled;
        settings.push(`Mirror painting: ${mirror_painting.enabled}`);

        if (
          mirror_painting.enabled &&
          (mirror_painting.axis ||
            mirror_painting.texture ||
            mirror_painting.texture_center)
        ) {
          // @ts-ignore
          const options = Painter.mirror_painting_options;
          if (mirror_painting.axis) {
            mirror_painting.axis.forEach((axis) => {
              options[axis] = true;
            });
          }
          if (mirror_painting.texture !== undefined) {
            options.texture = mirror_painting.texture;
          }
          if (mirror_painting.texture_center) {
            options.texture_center = mirror_painting.texture_center;
          }
          settings.push(`Mirror options updated`);
        }
      }

      // Lock alpha
      if (lock_alpha !== undefined) {
        Painter.lock_alpha = lock_alpha;
        settings.push(`Lock alpha: ${lock_alpha}`);
      }

      // Pixel perfect
      if (pixel_perfect !== undefined) {
        // @ts-ignore
        BarItems.pixel_perfect_drawing.set(pixel_perfect);
        settings.push(`Pixel perfect: ${pixel_perfect}`);
      }

      // Color erase mode
      if (color_erase_mode !== undefined) {
        // @ts-ignore
        BarItems.color_erase_mode.set(color_erase_mode);
        Painter.erase_mode = color_erase_mode;
        settings.push(`Color erase mode: ${color_erase_mode}`);
      }

      // Settings that require accessing the settings object
      if (paint_side_restrict !== undefined) {
        // @ts-ignore
        settings.paint_side_restrict.value = paint_side_restrict;
        settings.push(`Paint side restrict: ${paint_side_restrict}`);
      }

      if (brush_opacity_modifier !== undefined) {
        // @ts-ignore
        settings.brush_opacity_modifier.value = brush_opacity_modifier;
        settings.push(`Brush opacity modifier: ${brush_opacity_modifier}`);
      }

      if (brush_size_modifier !== undefined) {
        // @ts-ignore
        settings.brush_size_modifier.value = brush_size_modifier;
        settings.push(`Brush size modifier: ${brush_size_modifier}`);
      }

      if (paint_with_stylus_only !== undefined) {
        // @ts-ignore
        settings.paint_with_stylus_only.value = paint_with_stylus_only;
        settings.push(`Paint with stylus only: ${paint_with_stylus_only}`);
      }

      if (pick_color_opacity !== undefined) {
        // @ts-ignore
        settings.pick_color_opacity.value = pick_color_opacity;
        settings.push(`Pick color opacity: ${pick_color_opacity}`);
      }

      if (pick_combined_color !== undefined) {
        // @ts-ignore
        settings.pick_combined_color.value = pick_combined_color;
        settings.push(`Pick combined color: ${pick_combined_color}`);
      }

      return `Updated paint settings: ${settings.join(", ")}`;
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
        .tuple([z.number(), z.number(), z.number()])
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
 * Create a cylinder mesh.  The implementation follows the pattern of `create_sphere`:contentReference[oaicite:6]{index=6},
 * but constructs vertices around two circles and optionally caps them.
 */
createTool(
  "create_cylinder",
  {
    description: "Creates one or more cylinder meshes with optional end caps.",
    annotations: { title: "Create Cylinder", destructiveHint: true },
    parameters: z.object({
      elements: z
        .array(
          z.object({
            name: z.string(),
            position: z.tuple([z.number(), z.number(), z.number()]),
            height: z.number().min(1).max(64).default(16),
            diameter: z.number().min(1).max(64).default(16),
            sides: z.number().min(3).max(64).default(12),
            rotation: z
              .tuple([z.number(), z.number(), z.number()])
              .optional()
              .default([0, 0, 0]),
            capped: z.boolean().optional().default(true),
          })
        )
        .min(1),
      texture: z.string().optional(),
      group: z.string().optional(),
    }),
    async execute({ elements, texture, group }, { reportProgress }) {
      Undo.initEdit({ elements: [], outliner: true, collections: [] });
      const total = elements.length;
      const projectTexture = texture
        ? getProjectTexture(texture)
        : Texture.getDefault();
      if (!projectTexture) throw new Error(`Texture "${texture}" not found.`);
      const outlinerGroup = getAllGroups().find(
        (g) => g.name === group || g.uuid === group
      );
      const cylinders = elements.map((element, progress) => {
        const mesh = new Mesh({
          name: element.name,
          vertices: {},
          origin: element.position,
          rotation: element.rotation || [0, 0, 0],
        }).init();
        const radius = element.diameter / 2;
        const height = element.height;
        const sides = Math.round(element.sides);
        // centres for the caps
        const topCenter = mesh.addVertices([0, height / 2, 0])[0];
        const bottomCenter = mesh.addVertices([0, -height / 2, 0])[0];
        const topRing: any[] = [];
        const bottomRing: any[] = [];
        for (let i = 0; i < sides; i++) {
          const ang = (i / sides) * Math.PI * 2;
          const x = Math.cos(ang) * radius;
          const z = Math.sin(ang) * radius;
          topRing.push(mesh.addVertices([x, height / 2, z])[0]);
          bottomRing.push(mesh.addVertices([x, -height / 2, z])[0]);
        }
        for (let i = 0; i < sides; i++) {
          const next = (i + 1) % sides;
          // side face
          mesh.addFaces(
            new MeshFace(mesh, {
              vertices: [
                bottomRing[i],
                bottomRing[next],
                topRing[next],
                topRing[i],
              ],
              uv: {},
            })
          );
          if (element.capped) {
            // top cap (triangle fan)
            mesh.addFaces(
              new MeshFace(mesh, {
                vertices: [topRing[i], topRing[next], topCenter],
                uv: {},
              })
            );
            // bottom cap
            mesh.addFaces(
              new MeshFace(mesh, {
                vertices: [bottomRing[next], bottomRing[i], bottomCenter],
                uv: {},
              })
            );
          }
        }
        mesh.addTo(outlinerGroup);
        if (projectTexture) mesh.applyTexture(projectTexture);
        reportProgress({ progress, total });
        return mesh;
      });
      Undo.finishEdit("Agent created cylinders");
      Canvas.updateAll();
      return JSON.stringify(
        cylinders.map((c) => `Added cylinder ${c.name} (ID ${c.uuid})`)
      );
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

export default tools;
