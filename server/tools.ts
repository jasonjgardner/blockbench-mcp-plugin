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

createTool("place_cube", {
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
      (Array.isArray(faces) && faces.every((face) => typeof face === "string"));

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
        cube.applyTexture(projectTexture, faces !== false ? faces : undefined);
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
});

createTool("place_mesh", {
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
});

createTool("trigger_action", {
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
});

createTool("risky_eval", {
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
        message: "Code must not include 'console.', '//' or '/* */' comments.",
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
});

createTool("emulate_clicks", {
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
});

createTool("fill_dialog", {
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
});

createTool("create_texture", {
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
            .regex(/^[a-z]{3,20}$/, "Color name (e.g. 'red', 'blue', 'green')"),
        ])
        .optional()
        .describe("RGBA color to fill the texture, as tuple or HEX string."),
      layer_name: z
        .string()
        .optional()
        .describe("Name of the texture layer. Required if fill_color is set."),
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
      message: "The 'data' and 'fill_color' properties cannot both be defined.",
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
        message: "The 'group' property is required when 'pbr_channel' is set.",
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
});

createTool("apply_texture", {
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
});

createTool("remove_element", {
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
});

createTool("add_texture_group", {
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
});

createTool("modify_cube", {
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
});

createTool("add_group", {
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
});

createTool("list_textures", {
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
});

createTool("create_project", {
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
});

createTool("list_outline", {
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
});

createTool("get_texture", {
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
});

createTool("capture_screenshot", {
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
});

createTool("capture_app_screenshot", {
  description: "Returns the image data of the Blockbench app.",
  annotations: {
    title: "Capture App Screenshot",
    readOnlyHint: true,
  },
  parameters: z.object({}),
  async execute() {
    return captureAppScreenshot();
  },
});

createTool("set_camera_angle", {
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
});

createTool("from_geo_json", {
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
});

createTool("create_animation", {
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
            position: z.tuple([z.number(), z.number(), z.number()]).optional(),
            rotation: z.tuple([z.number(), z.number(), z.number()]).optional(),
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
});

createTool("create_sphere", {
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
});

createTool("select_mesh_elements", {
  description: "Selects vertices, edges, or faces of a mesh for manipulation.",
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
          z.string().describe("Vertex key, edge as 'vkey1-vkey2', or face key"),
          z.number().describe("Index of the element"),
        ])
      )
      .optional()
      .describe("Specific elements to select. If not provided, selects all."),
    action: z
      .enum(["select", "add", "remove", "toggle"])
      .default("select")
      .describe("Selection action: select (replace), add, remove, or toggle."),
  }),
  async execute({ mesh_id, mode, elements, action }) {
    const mesh = Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id);
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
});

createTool("move_mesh_vertices", {
  description: "Moves selected vertices of a mesh by the specified offset.",
  annotations: {
    title: "Move Mesh Vertices",
    destructiveHint: true,
  },
  parameters: z.object({
    mesh_id: z
      .string()
      .optional()
      .describe("ID or name of the mesh. If not provided, uses selected mesh."),
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
});

createTool("extrude_mesh", {
  description: "Extrudes selected faces or edges of a mesh.",
  annotations: {
    title: "Extrude Mesh",
    destructiveHint: true,
  },
  parameters: z.object({
    mesh_id: z
      .string()
      .optional()
      .describe("ID or name of the mesh. If not provided, uses selected mesh."),
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
});

createTool("subdivide_mesh", {
  description: "Subdivides selected faces of a mesh to create more geometry.",
  annotations: {
    title: "Subdivide Mesh",
    destructiveHint: true,
  },
  parameters: z.object({
    mesh_id: z
      .string()
      .optional()
      .describe("ID or name of the mesh. If not provided, uses selected mesh."),
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
});

createTool("knife_tool", {
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
    const mesh = Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id);
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
});

createTool("set_mesh_uv", {
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
    const mesh = Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id);
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
});

createTool("auto_uv_mesh", {
  description: "Automatically generates UV mapping for selected mesh faces.",
  annotations: {
    title: "Auto UV Mesh",
    destructiveHint: true,
  },
  parameters: z.object({
    mesh_id: z
      .string()
      .optional()
      .describe("ID or name of the mesh. If not provided, uses selected mesh."),
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
            const u = ((phi + Math.PI) / (2 * Math.PI)) * Project.texture_width;
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
});

createTool("rotate_mesh_uv", {
  description: "Rotates UV coordinates of selected mesh faces.",
  annotations: {
    title: "Rotate Mesh UV",
    destructiveHint: true,
  },
  parameters: z.object({
    mesh_id: z
      .string()
      .optional()
      .describe("ID or name of the mesh. If not provided, uses selected mesh."),
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
});

createTool("merge_mesh_vertices", {
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
    const mesh = Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id);
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
});

createTool("create_mesh_face", {
  description: "Creates a new face from selected vertices.",
  annotations: {
    title: "Create Mesh Face",
    destructiveHint: true,
  },
  parameters: z.object({
    mesh_id: z
      .string()
      .optional()
      .describe("ID or name of the mesh. If not provided, uses selected mesh."),
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
});

createTool("delete_mesh_elements", {
  description: "Deletes selected vertices, edges, or faces from a mesh.",
  annotations: {
    title: "Delete Mesh Elements",
    destructiveHint: true,
  },
  parameters: z.object({
    mesh_id: z
      .string()
      .optional()
      .describe("ID or name of the mesh. If not provided, uses selected mesh."),
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
});

export default tools;
