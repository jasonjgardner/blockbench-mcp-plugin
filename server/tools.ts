/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, tools } from "@/lib/factories";
import {
  getProjectTexture,
  fixCircularReferences,
  captureScreenshot,
  captureAppScreenshot,
} from "@/lib/util";
import { imageContent } from "fastmcp";

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

      console.log(color.toRgbString().toLowerCase());

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

export default tools;
