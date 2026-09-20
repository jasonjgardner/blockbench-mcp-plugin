/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import { SCRATCHPAD_MODE_ID, GEOMETRY_EPSILON, STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { runUndoableEdit } from "@/lib/undo";
import { isHytaleFormat } from "@/lib/hytale";

const directions = ["north", "east", "south", "west", "up", "down"] as const;
type Direction = typeof directions[number];
/** Model axes determining each unrotated face's width and height. Stretch does not change these UV dimensions. */
const faceSizeAxes: Record<Direction, readonly [number, number]> = {
  north: [0, 1], south: [0, 1], east: [2, 1], west: [2, 1], up: [0, 2], down: [0, 2],
};

/** Explicit cube identity for selection-independent inspection of logical UV coordinates. */
export const getCubeUvParameters = z.object({
  id: z.string().min(1).describe("Cube UUID or unique name. UUID takes precedence over names."),
});

function facePatchSchema() {
  return z.object({
    uv: z.array(z.number().finite()).length(4).optional().describe("[u1, v1, u2, v2] in logical UV units, not necessarily bitmap pixels. Reversed and out-of-bounds rectangles are preserved. Hytale requires extents matching cube face dimensions, swapped for 90/270-degree rotation; offsets and mirroring are supported."),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional().describe("UV rotation in degrees; nonzero rotation requires format uv_rotation support."),
    texture: z.union([z.string().min(1), z.literal(false), z.null()]).optional().describe("Texture UUID, ID or unique name; false unassigns, null disables the face. Omit to preserve."),
  }).strict();
}

/**
 * Cube UV patch. Box offsets and per-face rectangles are mutually exclusive at
 * runtime according to the resulting cube UV mode. Mode conversion is explicit
 * because native conversion may reset rotations and enable disabled faces.
 */
export const setCubeUvParameters = z.object({
  id: z.string().min(1).describe("Cube UUID or unique name. Does not use or change selection."),
  box_uv: z.boolean().optional().describe("Explicitly convert UV mode using the native cube operation. Requires optional_box_uv to change mode. Conversion can reset rotations and enable disabled faces."),
  uv_offset: z.array(z.number().finite()).length(2).optional().describe("Box UV net offset [u, v]; requires box UV mode."),
  mirror_uv: z.boolean().optional().describe("Mirror the box UV net; requires box UV mode. For per-face mirroring, reverse rectangle endpoints."),
  faces: z.object({
    north: facePatchSchema().optional(), east: facePatchSchema().optional(),
    south: facePatchSchema().optional(), west: facePatchSchema().optional(),
    up: facePatchSchema().optional(), down: facePatchSchema().optional(),
  }).strict().optional().describe("Patch only these faces in per-face UV mode. Other faces are preserved. Explicit rectangles disable automatic UV remapping except in Hytale, where dimension-linked UVs retain native Auto UV. Hytale textures resolve through the project/attachment collection, so only null is accepted as an explicit face texture."),
}).strict();

/** Native cube UV inspection/editing specs; importing these schemas does not read host globals. */
export const cubeUvToolDocs: IToolSpec[] = [
  {
    name: "get_cube_uv",
    condition: { project: true },
    description: "Inspect a cube's UV mode, offset, mirroring, six face rectangles/rotations, stored and effective texture references, logical UV sizes and bitmap sizes. Read-only; no selection or preview changes.",
    annotations: { title: "Get Cube UV", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: getCubeUvParameters,
    status: STATUS_STABLE,
  },
  {
    name: "set_cube_uv",
    condition: { project: true, features: ["edit_mode"], modes: ["edit", "paint", SCRATCHPAD_MODE_ID] },
    description: "Edit box UV offsets/mirroring or per-face rectangles, rotation and texture references in one reversible edit. Preserves untargeted faces and selection. Validates UV mode, texture references and rotation support. Hytale rectangles must retain geometry-linked extents and Auto UV; texture assignments use the project/attachment collection, and quads cannot use box UV. Does not pack islands or repaint textures.",
    annotations: { title: "Set Cube UV", destructiveHint: true, openWorldHint: false },
    parameters: setCubeUvParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

/** Resolves UUID first, rejecting ambiguous names instead of editing multiple cubes. */
function resolveCube(id: string): Cube {
  const exact = Cube.all.find(cube => cube.uuid === id);
  if (exact) return exact;
  const named = Cube.all.filter(cube => cube.name === id);
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new Error(`Cube name "${id}" is ambiguous. Use a UUID from list_outline.`);
  throw new Error(`Cube "${id}" not found. Use list_outline to inspect cube UUIDs.`);
}

/** Resolves texture identity before starting Undo, including ambiguous IDs/names. */
function resolveTexture(reference: string): Texture {
  const textures = Project?.textures ?? [];
  const exact = textures.find(texture => texture.uuid === reference);
  if (exact) return exact;
  const matches = textures.filter(texture => texture.id === reference || texture.name === reference);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Texture "${reference}" is ambiguous. Use its UUID.`);
  throw new Error(`Texture "${reference}" not found in the active project.`);
}

/** Detached UV snapshot; native face resolution honors single/per-group texture formats. */
function snapshot(cube: Cube) {
  return {
    uuid: cube.uuid,
    name: cube.name,
    box_uv: cube.box_uv,
    autouv: cube.autouv,
    uv_offset: [...cube.uv_offset],
    mirror_uv: cube.mirror_uv,
    faces: Object.fromEntries(directions.map(direction => {
      const face = cube.faces[direction];
      const texture = face.getTexture();
      return [direction, {
        uv: [...face.uv],
        rotation: face.rotation,
        texture: face.texture ?? null,
        texture_status: face.texture === null ? "disabled" : texture ? "resolved" : typeof face.texture === "string" ? "missing" : "unassigned",
        effective_texture: texture ? { uuid: texture.uuid, name: texture.name } : null,
        uv_size: texture ? [texture.getUVWidth(), texture.getUVHeight()] : [Project?.texture_width ?? 0, Project?.texture_height ?? 0],
        bitmap_size: texture ? [texture.width, texture.height] : null,
        frame_size: texture ? [texture.width, texture.display_height] : null,
      }];
    })),
    notes: [
      "UV rectangles use logical UV units. Convert to pixels within the active frame using frame_size / uv_size on each axis. bitmap_size includes all animation frames.",
      "Box UV face rectangles are the host's current generated net; edit uv_offset/mirror_uv or explicitly convert mode before editing individual rectangles.",
      "Effective textures follow native format rules, including single_texture and per_group_texture. Stored face references may differ.",
    ],
  };
}

type FacePatch = z.infer<ReturnType<typeof facePatchSchema>>;
type PreparedFacePatch = { direction: Direction; patch: FacePatch; texture?: Texture | false | null };

/** Validates Hytale's dimension-linked face UVs before its finish_edit hook could silently rewrite them. */
function validateHytaleFaces(cube: Cube, box: boolean, patches: { direction: Direction; patch: FacePatch }[]): void {
  const size = cube.size().map(Math.abs);
  if (size.some(value => !Number.isFinite(value))) throw new Error("Hytale UV editing requires finite cube dimensions.");
  // Matches the installed plugin's cubeIsQuad predicate and setUVMode override.
  if (box && size.includes(0) && directions.filter(direction => cube.faces[direction].texture !== null).length <= 1) {
    throw new Error("Hytale quads cannot use box UV. Keep per-face UV mode.");
  }
  patches.forEach(({ direction, patch }) => {
    if (patch.uv === undefined && patch.rotation === undefined) return;
    const face = cube.faces[direction];
    const rotation = patch.rotation ?? face.rotation;
    const dimensions = faceSizeAxes[direction].map(axis => size[axis]);
    const expected = rotation === 90 || rotation === 270 ? dimensions.toReversed() : dimensions;
    const uv = patch.uv ?? face.uv;
    const actual = [Math.abs(uv[2] - uv[0]), Math.abs(uv[3] - uv[1])];
    if (actual.some((value, axis) => !Number.isFinite(value) || Math.abs(value - expected[axis]) > GEOMETRY_EPSILON)) {
      throw new Error(`Hytale face "${direction}" requires UV extents ${expected[0]}x${expected[1]} for its cube dimensions and rotation. Preserve those extents when moving/mirroring UVs; supply a matching rectangle with a rotation change.`);
    }
  });
}

/** Validate all format restrictions and references before applying any part of a patch. */
function prepareFaces(cube: Cube, input: z.infer<typeof setCubeUvParameters>): PreparedFacePatch[] {
  const box = input.box_uv ?? cube.box_uv;
  if (input.box_uv !== undefined && input.box_uv !== cube.box_uv && !Format.optional_box_uv) {
    throw new Error("The current format does not support changing a cube's UV mode.");
  }
  const patches = directions.flatMap(direction => {
    const patch = input.faces?.[direction];
    return patch ? [{ direction, patch }] : [];
  });
  if (box && patches.length) throw new Error("Per-face patches require per-face UV mode. Use box offsets or explicitly set box_uv=false in a supported format.");
  if (!box && (input.uv_offset !== undefined || input.mirror_uv !== undefined)) {
    throw new Error("uv_offset and mirror_uv require box UV mode.");
  }
  if (patches.some(({ patch }) => patch.rotation && !Format.uv_rotation)) {
    throw new Error("The current format does not support UV rotation.");
  }
  if (patches.some(({ patch }) => typeof patch.texture === "string" || patch.texture === false) && (Format.single_texture || Format.per_group_texture || isHytaleFormat())) {
    throw new Error("This format resolves textures at project/group level or through Hytale attachment collections. Assign textures there; per-face texture assignment would not control the rendered result.");
  }
  if (input.box_uv === undefined && input.uv_offset === undefined && input.mirror_uv === undefined && !patches.some(({ patch }) => Object.keys(patch).length)) {
    throw new Error("Provide at least one UV mode, offset, mirror, or face property to change.");
  }
  if (isHytaleFormat()) validateHytaleFaces(cube, box, patches);
  return patches.map(({ direction, patch }) => ({
    direction, patch,
    texture: typeof patch.texture === "string" ? resolveTexture(patch.texture) : patch.texture,
  }));
}

/** Registers explicit-target cube UV inspection and editing, with native Undo and preview updates. */
export function registerCubeUvTools(): void {
  createTool(cubeUvToolDocs[0].name, {
    ...cubeUvToolDocs[0], parameters: getCubeUvParameters,
    async execute({ id }) {
      const result = snapshot(resolveCube(id));
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  }, cubeUvToolDocs[0].status);
  createTool(cubeUvToolDocs[1].name, {
    ...cubeUvToolDocs[1], parameters: setCubeUvParameters,
    async execute(input) {
      const cube = resolveCube(input.id);
      const patches = prepareFaces(cube, input);
      // uv_only is native Undo state, omitted from the published UndoAspects type.
      const aspects = { elements: [cube], uv_only: true };
      return runUndoableEdit(aspects, "Edit cube UV", () => {
        if (input.box_uv !== undefined) {
          cube.setUVMode(input.box_uv);
          if (cube.box_uv !== input.box_uv) throw new Error("The native format declined this cube UV mode change; the edit was reverted.");
        }
        if (input.uv_offset) cube.uv_offset = [input.uv_offset[0], input.uv_offset[1]];
        if (input.mirror_uv !== undefined) cube.mirror_uv = input.mirror_uv;
        if (isHytaleFormat()) cube.autouv = 1;
        if (!isHytaleFormat() && patches.some(({ patch }) => patch.uv !== undefined)) cube.autouv = 0;
        patches.forEach(({ direction, patch, texture }) => {
          const face = cube.faces[direction];
          if (patch.uv) face.uv = [patch.uv[0], patch.uv[1], patch.uv[2], patch.uv[3]];
          if (patch.rotation !== undefined) face.rotation = patch.rotation;
          // Native null disables a face; the published CubeFace type omits null.
          if (texture !== undefined) Object.assign(face, { texture: texture ? texture.uuid : texture });
        });
        Canvas.updateView({ elements: [cube], element_aspects: { faces: true, uv: true } });
        UVEditor.loadData();
        return `Updated UV mapping for cube "${cube.name}" (${cube.uuid}).`;
      });
    },
  }, cubeUvToolDocs[1].status);
}
