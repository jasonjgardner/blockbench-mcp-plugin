/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import { cubeSchema } from "@/lib/zodObjects";
import { GEOMETRY_EPSILON, STATUS_STABLE } from "@/lib/constants";
import { getProjectTexture } from "@/lib/util";
import { runUndoableEdit } from "@/lib/undo";
import { isHytaleFormat } from "@/lib/hytale";

/** Java Edition 26.3+ face-direction shading override values; empty string means no override. */
export const shadeDirectionOverrideEnum = z
  .enum(["", "north", "south", "west", "east", "up", "down"])
  .describe("Java Edition 26.3+ shade direction override: the face direction whose lighting shade is applied to every face. '' removes the override. Replaces the boolean shade flag in formats with java_cube_shade_direction_override (new Java Block projects default to 26.3).");

/** Java block light emission level, exported for formats with Java cube shading properties. */
const lightEmissionSchema = z
  .number()
  .int()
  .min(0)
  .max(15)
  .describe("Block light emitted by the cube (0-15). Exported by Java Block formats.");

/** Legacy boolean shading flag; mapped to shade_direction_override 'up' when false in Java 26.3+ projects. */
const shadeSchema = z
  .boolean()
  .describe("Whether to apply shading to the cube. Java 26.3+ projects ignore this flag; shade=false is mapped to shade_direction_override 'up' there, matching Blockbench's own import.");

/** Shading-related cube fields accepted by place_cube elements and modify_cube. */
export interface ICubeShadingInput {
  shade?: boolean;
  shade_direction_override?: z.infer<typeof shadeDirectionOverrideEnum>;
  light_emission?: number;
}

/** Format flags that decide how shading input is stored. */
export interface ICubeShadingFormat {
  /** `Format.java_cube_shading_properties`: shade/light_emission are exported. */
  shading_properties: boolean;
  /** `Format.java_cube_shade_direction_override`: Java 26.3+, where `shade` is hidden and ignored. */
  direction_override: boolean;
}

/** Cube property patch plus notes explaining any translation applied. */
export interface ICubeShadingPlan {
  patch: ICubeShadingInput;
  notes: string[];
}

/**
 * Translates shading input into the cube properties the active format honors.
 *
 * Mirrors Blockbench 5.2's Java block import compatibility: in 26.3+ projects
 * (`direction_override`) the `shade` flag is ignored, so `shade: false` without an
 * explicit override becomes `shade_direction_override: 'up'`; in older formats a
 * non-empty override without `shade` implies `shade: false`. Pure and global-free.
 *
 * @param input - Requested shading fields; undefined fields are left unchanged.
 * @param format - Flags read from the active `Format` at execution time.
 * @returns Properties to merge into the cube and human-readable notes.
 */
export function planCubeShading(input: ICubeShadingInput, format: ICubeShadingFormat): ICubeShadingPlan {
  const { shade, shade_direction_override: override, light_emission } = input;
  const mapsShadeToOverride = format.direction_override && shade === false && override === undefined;
  const impliesNoShade = !format.direction_override && Boolean(override) && shade === undefined;
  const patch: ICubeShadingInput = {
    ...(shade !== undefined && { shade }),
    ...(impliesNoShade && { shade: false }),
    ...(override !== undefined && { shade_direction_override: override }),
    ...(mapsShadeToOverride && { shade_direction_override: "up" as const }),
    ...(light_emission !== undefined && { light_emission }),
  };
  const notes = [
    mapsShadeToOverride ? "This Java 26.3+ project ignores `shade`; shade=false was stored as shade_direction_override 'up'." : "",
    impliesNoShade ? "This format predates shade_direction_override (Java 26.3+); Blockbench drops the override in this format, so only shade=false was stored." : "",
    format.direction_override && shade === true && override === undefined ? "This Java 26.3+ project ignores `shade`; use shade_direction_override '' to remove an override." : "",
    light_emission !== undefined && !format.shading_properties ? "light_emission is only exported by Java Block formats." : "",
  ];
  return { patch, notes: notes.filter((note) => note.length > 0) };
}

/** Reads the shading flags from the active format; call only inside execute(). */
function activeShadingFormat(): ICubeShadingFormat {
  const flags = Format as unknown as { java_cube_shading_properties?: boolean; java_cube_shade_direction_override?: boolean };
  return {
    shading_properties: Boolean(flags.java_cube_shading_properties),
    direction_override: Boolean(flags.java_cube_shade_direction_override),
  };
}

/** A place_cube element: shared geometry plus optional shading fields. */
const placeCubeElementSchema = cubeSchema.extend({
  shade: shadeSchema.optional(),
  shade_direction_override: shadeDirectionOverrideEnum.optional(),
  light_emission: lightEmissionSchema.optional(),
});

/**
 * Creates a nonempty batch of cubes with optional texture and parent references.
 * Faces default to automatic UV on all sides; false skips texture assignment
 * and disables Auto UV outside Hytale, which always requires Auto UV 1.
 * Explicit arrays never depend on UV editor selection.
 */
export const placeCubeParameters = z.object({
  elements: z.array(placeCubeElementSchema).min(1).describe("Array of cubes to place, with optional Java shading fields."),
  texture: z
    .string()
    .optional()
    .describe("Texture UUID, ID or name. When omitted, uses the default texture if one exists; otherwise creates untextured cubes."),
  group: z
    .string()
    .optional()
    .describe("Parent group UUID or unique name, or root (default). Missing or ambiguous names are rejected."),
  faces: z
    .union([
      z
        .array(z.enum(["north", "south", "east", "west", "up", "down"]))
        .describe("Array of faces to apply the texture to."),
      z
        .boolean()
        .optional()
        .describe(
          "true applies texture to all faces with Auto UV; false skips texture assignment and disables Auto UV except in Hytale, which requires Auto UV 1."
        ),
      z
        .array(
          z.object({
            face: z
              .enum(["north", "south", "east", "west", "up", "down"])
              .describe("Face to apply the texture to."),
            uv: z
              .array(z.number().finite()).length(4)
              .describe("Custom UV rectangle. Hytale requires absolute width/height to match the cube's face dimensions: north/south XY, east/west ZY, up/down XZ."),
          })
        )
        .describe("Array of faces with custom UV mapping."),
    ])
    .optional()
    .default(true)
    .describe(
      "true applies texture to all faces with Auto UV; false skips texture assignment. Named faces use Auto UV; false/custom rectangles disable Auto UV outside Hytale. Hytale always retains Auto UV 1 and custom rectangles must match the geometry's face dimensions. Partial/custom faces require per-face UV support. Single-texture formats may still display the project texture."
    ),
});

/** Optional geometry, appearance and UV properties for existing cube targets. */
export const modifyCubeParameters = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "ID or name of the cube to modify. Defaults to selected, which could be more than one."
    ),
  name: z.string().optional().describe("New name of the cube."),
  origin: z
    .array(z.number()).length(3)
    .optional()
    .describe("Pivot point of the cube."),
  from: z
    .array(z.number()).length(3)
    .optional()
    .describe("Starting point of the cube."),
  to: z
    .array(z.number()).length(3)
    .optional()
    .describe("Ending point of the cube."),
  rotation: z
    .array(z.number()).length(3)
    .optional()
    .describe("Rotation of the cube."),
  autouv: z
    .enum(["0", "1", "2"])
    .optional()
    .describe(
      "Auto UV setting. 0 = disabled, 1 = enabled, 2 = relative auto UV."
    ),
  uv_offset: z
    .array(z.number()).length(2)
    .optional()
    .describe("UV offset for the texture."),
  mirror_uv: z.boolean().optional().describe("Whether to mirror the UVs."),
  shade: shadeSchema.optional(),
  shade_direction_override: shadeDirectionOverrideEnum.optional(),
  light_emission: lightEmissionSchema.optional(),
  inflate: z.number().optional().describe("Inflation amount for the cube."),
  color: z
    .number()
    .optional()
    .describe("Single digit to represent a color from a palette."),
  visibility: z
    .boolean()
    .optional()
    .describe("Whether the cube is visible or not."),
});

/** Schema-only cube tool specifications used by registration and generated API documentation. */
export const cubeToolDocs: IToolSpec[] = [
  {
    name: "place_cube",
    condition: { project: true, features: ["edit_mode"] },
    description:
      "Creates cubes in one reversible edit. Texture and group are optional, allowing untextured blockouts. Explicit face targets never use the current UV selection; partial/custom faces require per-face UV support.",
    annotations: {
      title: "Place Cube",
      destructiveHint: true,
    },
    parameters: placeCubeParameters,
    status: STATUS_STABLE,
  },
  {
    name: "modify_cube",
    condition: { project: true, features: ["edit_mode"] },
    description:
      "Modifies the cube with the given ID. Auto UV setting: saved as an integer, where 0 means disabled, 1 means enabled, and 2 means relative auto UV (cube position affects UV)",
    annotations: {
      title: "Modify Cube",
      destructiveHint: true,
    },
    parameters: modifyCubeParameters,
    status: STATUS_STABLE,
  },
];

/** Accepted creation arguments after schema defaults have been applied. */
type PlaceCubeInput = z.infer<typeof placeCubeParameters>;
/** A named side of a native cube. */
type CubeSide = CubeFaceDirection;
/** An explicit side and its UV rectangle in texture coordinates. */
type FaceRectangle = { face: CubeSide; uv: number[] };

/** Native unrotated face axes used by Auto UV 1; creation does not set face UV rotation. */
const faceSizeAxes: Record<CubeSide, readonly [number, number]> = {
  north: [0, 1], south: [0, 1], east: [2, 1], west: [2, 1], up: [0, 2], down: [0, 2],
};

/** Rejects an entire Hytale creation batch before Undo when a rectangle would be remapped by the host. */
function validateHytaleRectangles(elements: PlaceCubeInput["elements"], rectangles: FaceRectangle[]): void {
  elements.forEach(element => {
    const size = element.to.map((value, axis) => Math.abs(value - element.from[axis]));
    if (size.some(value => !Number.isFinite(value))) throw new Error("Hytale cube dimensions must be finite.");
    rectangles.forEach(({ face, uv }) => {
      const expected = faceSizeAxes[face].map(axis => size[axis]);
      const actual = [Math.abs(uv[2] - uv[0]), Math.abs(uv[3] - uv[1])];
      if (actual.some((value, axis) => !Number.isFinite(value) || Math.abs(value - expected[axis]) > GEOMETRY_EPSILON)) {
        throw new Error(`Hytale cube "${element.name}" face "${face}" requires UV extents ${expected[0]}x${expected[1]} for its dimensions. Move or mirror the rectangle while preserving those extents.`);
      }
    });
  });
}

/** Resolves an explicit parent without silently placing cubes at the root. */
function cubeParent(reference: string | undefined): Group | "root" {
  if (reference === undefined || reference === "root") return "root";
  const byUuid = Group.all.find(candidate => candidate.uuid === reference);
  if (byUuid) return byUuid;
  const matches = Group.all.filter(candidate => candidate.name === reference);
  if (matches.length === 0) throw new Error(`Parent group "${reference}" not found. Use list_outline to inspect group UUIDs and names.`);
  if (matches.length > 1) throw new Error(`Parent group name "${reference}" is ambiguous. Use its UUID.`);
  return matches[0];
}

/** Narrows the public face union without assuming the first array entry exists. */
function isFaceRectangle(face: CubeSide | FaceRectangle): face is FaceRectangle {
  return typeof face !== "string";
}

/** Creates validated cubes, tracking new elements before initialization can fail. */
async function placeCubes({ elements, texture, faces, group }: PlaceCubeInput): Promise<string> {
  if (typeof Project === "undefined" || !Project) throw new Error("Open a project before creating cubes.");
  if (elements.some(element => [element.from, element.to, element.origin, element.rotation].flat().some(value => !Number.isFinite(value)))) {
    throw new Error("Cube coordinates and rotations must contain only finite numbers.");
  }
  const parent = cubeParent(group);
  const projectTexture = texture === undefined ? Texture.getDefault() : getProjectTexture(texture);
  if (texture !== undefined && !projectTexture) throw new Error(`No texture found for "${texture}".`);

  const explicitFaces = Array.isArray(faces) ? faces : [];
  const rectangles = explicitFaces.filter(isFaceRectangle);
  const sides = explicitFaces.map(face => typeof face === "string" ? face : face.face);
  if (new Set(sides).size !== sides.length) throw new Error("Each cube face may only be specified once.");
  const needsPerFace = rectangles.length > 0 || (sides.length > 0 && sides.length < 6);
  if (needsPerFace && Format.box_uv && !Format.optional_box_uv) {
    throw new Error("The current format only supports box UV. Custom UV rectangles and partial face texture assignments require per-face UV support.");
  }
  const hytale = isHytaleFormat();
  if (hytale) validateHytaleRectangles(elements, rectangles);
  const autouv = hytale || faces === true || (Array.isArray(faces) && rectangles.length === 0 && sides.length > 0);
  const shadingFormat = activeShadingFormat();
  const shading = elements.map(element => planCubeShading(element, shadingFormat));
  const cubes: Cube[] = [];
  runUndoableEdit({ elements: cubes, outliner: true }, "Agent placed cubes", () => {
    elements.forEach((element, index) => {
      const cube = new Cube({
        ...shading[index].patch,
        autouv: autouv ? 1 : 0,
        name: element.name,
        from: element.from as [number, number, number],
        to: element.to as [number, number, number],
        origin: element.origin as [number, number, number],
        rotation: element.rotation as [number, number, number],
      });
      cubes.push(cube);
      if (needsPerFace) cube.box_uv = false;
      cube.init().addTo(parent);
      if (cube.parent !== parent) throw new Error("The current format does not allow the requested cube parent.");
      if (projectTexture && faces !== false && (faces === true || sides.length > 0)) {
        cube.applyTexture(projectTexture, faces === true ? true : sides);
      }
      if (autouv) cube.mapAutoUV();
      rectangles.forEach(({ face, uv }) => {
        cube.faces[face].extend({ uv: uv as [number, number, number, number] });
      });
    });
    Canvas.updateAll();
  });
  const notes = [...new Set(shading.flatMap(plan => plan.notes))];
  return JSON.stringify([...cubes.map(cube => `Added cube ${cube.name} with ID ${cube.uuid}`), ...notes]);
}

/** Registers the cube tools with their shared parameter schemas and runtime implementations. */
export function registerCubesTools(): void {
createTool(cubeToolDocs[0].name, {
  ...cubeToolDocs[0],
  parameters: placeCubeParameters,
  execute: placeCubes,
}, cubeToolDocs[0].status);

createTool(cubeToolDocs[1].name, {
  ...cubeToolDocs[1],
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
    shade_direction_override,
    light_emission,
    inflate,
    color,
    visibility,
  }) {
    let cubes: Cube[];
    if (id) {
      cubes = (Cube.all ?? []).filter((el: Cube) => el.uuid === id || el.name === id);
      if (!cubes.length) {
        throw new Error(`Cube with ID "${id}" not found. Use the list_outline tool to see available cubes.`);
      }
    } else {
      cubes = Cube.selected;
      if (!cubes.length) {
        throw new Error("No cube selected and no id provided. Select a cube or provide an id.");
      }
    }

    const shading = planCubeShading({ shade, shade_direction_override, light_emission }, activeShadingFormat());

    Undo.initEdit({
      elements: Array.isArray(cubes) ? cubes : [cubes],
      outliner: true,
      collections: [],
    });

    cubes.forEach((cube) => {
      const cubeOrigin: [number, number, number] = (origin ?? cube.origin) as [number, number, number];
      const cubeFrom: [number, number, number] = (from ?? cube.from) as [number, number, number];
      const cubeTo: [number, number, number] = (to ?? cube.to) as [number, number, number];
      const cubeRotation: [number, number, number] = (rotation ?? cube.rotation) as [number, number, number];
      const cubeUVOffset: [number, number] = (uv_offset ?? cube.uv_offset) as [number, number];

      cube.extend({
        name: name ?? cube.name,
        origin: cubeOrigin,
        from: cubeFrom,
        to: cubeTo,
        rotation: cubeRotation,
        uv_offset: cubeUVOffset,
        autouv: autouv ? (Number(autouv) as 0 | 1 | 2) : cube.autouv,
        mirror_uv: Boolean(mirror_uv ?? cube.mirror_uv),
        inflate: inflate ?? cube.inflate,
        color: color ?? cube.color,
        visibility: visibility ?? cube.visibility,
        ...shading.patch,
      });
    });

    Undo.finishEdit("Agent modified cubes");
    Canvas.updateAll();

    const summary = `Modified cubes ${cubes
      .map((cube) => cube.name)
      .join(", ")} with IDs ${cubes.map((cube) => cube.uuid).join(", ")}`;
    return [summary, ...shading.notes].join(" ");
  },
}, cubeToolDocs[1].status);
}
