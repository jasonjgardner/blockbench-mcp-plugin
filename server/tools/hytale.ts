/// <reference types="three" />
/// <reference types="blockbench-types" />

import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import {
  isHytalePluginInstalled,
  isHytaleFormat,
  getHytaleFormatType,
  getHytaleBlockSize,
  getHytaleTextureDimensionIssues,
  getAttachmentCollections,
  findAttachmentCollection,
  getAttachmentPieces,
  getCubeShadingMode,
  isCubeDoubleSided,
  validateNodeCount,
  getHytaleAnimationFPS,
  HYTALE_SHADING_MODES,
  HYTALE_QUAD_NORMALS,
  type IHytaleCube,
  type IHytaleGroup,
  type IHytaleAttachmentCollection,
} from "@/lib/hytale";
import { findGroupOrThrow, findElementOrThrow } from "@/lib/util";
import { runUndoableEdit } from "@/lib/undo";
import { runUndoableAnimationEdit } from "@/lib/animation-undo";
import { findAnimationOrSelected } from "./animation/shared";
import {
  cubeIdOptionalSchema,
  vector3Schema,
  groupIdOptionalSchema,
  animationIdOptionalSchema,
  boneNameSchema,
  stretchSchema,
  size2dSchema,
} from "@/lib/zodObjects";

// ============================================================================
// Hytale-Specific Enums
// ============================================================================

/** Hytale shading modes */
export const hytaleShadingModeEnum = z.enum(HYTALE_SHADING_MODES);

/** Hytale quad normal directions */
export const hytaleQuadNormalEnum = z.enum(HYTALE_QUAD_NORMALS);

/** Hytale loop modes */
export const hytaleLoopModeEnum = z.enum(["loop", "hold", "once"]);

// ============================================================================
// Hytale Tool Parameter Schemas
// ============================================================================

/** Empty parameters schema for read-only tools */
export const emptyParametersSchema = z.object({});

/** Parameters for setting Hytale cube properties */
export const hytaleSetCubePropertiesParametersSchema = z.object({
  cube_id: cubeIdOptionalSchema,
  shading_mode: hytaleShadingModeEnum
    .optional()
    .describe("Shading mode: flat (no lighting), standard (normal), fullbright (emissive), reflective"),
  double_sided: z
    .boolean()
    .optional()
    .describe("Whether to render both sides of faces"),
});

/** Parameters for getting Hytale cube properties */
export const hytaleGetCubePropertiesParametersSchema = z.object({
  cube_id: cubeIdOptionalSchema,
});

/** Parameters for creating a Hytale quad */
export const hytaleCreateQuadParametersSchema = z.object({
  name: z.string().describe("Name for the quad"),
  position: vector3Schema.refine(value => value.every(Number.isFinite), "Quad position must contain finite numbers.")
    .default([0, 0, 0]).describe("Finite position [x, y, z] of the quad's starting corner."),
  normal: hytaleQuadNormalEnum
    .default("+Y")
    .describe("Normal direction: +X, -X, +Y, -Y, +Z, -Z"),
  size: size2dSchema.refine(value => value.every(dimension => Number.isFinite(dimension) && dimension > 0), "Quad width and height must be finite and positive.")
    .default([16, 16]).describe("Positive finite [width, height]. Width/height axes are Z/Y for X normals, X/Z for Y normals, and X/Y for Z normals."),
  group: groupIdOptionalSchema.describe("Parent group UUID or unique name, or root (default). Missing or ambiguous names are rejected."),
  double_sided: z
    .boolean()
    .default(true)
    .describe("Whether to render both sides"),
});

/** Parameters for setting attachment piece */
export const hytaleSetAttachmentPieceParametersSchema = z.object({
  group_name: z.string().describe("Name of the group to mark as attachment piece"),
  is_piece: z.boolean().describe("Whether the group is an attachment piece"),
});

/** Parameters for creating visibility keyframe */
export const hytaleCreateVisibilityKeyframeParametersSchema = z.object({
  bone_name: boneNameSchema,
  time: z.number().finite().min(0).max(10000).describe("Finite time in seconds between 0 and 10000 for the visibility keyframe."),
  visible: z.boolean().describe("Whether the bone is visible at this keyframe"),
  animation_id: animationIdOptionalSchema,
});

/** Parameters for setting animation loop mode */
export const hytaleSetAnimationLoopParametersSchema = z.object({
  animation_id: animationIdOptionalSchema,
  loop_mode: hytaleLoopModeEnum.describe(
    "Loop mode: loop (continuous), hold (freeze on last frame), once (play once)"
  ),
});

/** Parameters for setting cube stretch */
export const hytaleSetCubeStretchParametersSchema = z.object({
  cube_id: cubeIdOptionalSchema,
  stretch: stretchSchema,
});

/** Parameters for getting cube stretch */
export const hytaleGetCubeStretchParametersSchema = z.object({
  cube_id: cubeIdOptionalSchema,
});

// ============================================================================
// Hytale Tool Docs
// ============================================================================

export const hytaleToolDocs: IToolSpec[] = [
  {
    name: "hytale_get_format_info",
    condition: { project: true, method: () => isHytalePluginInstalled() && isHytaleFormat() },
    description:
      "Returns information about the current Hytale format. Requires the Hytale plugin and a Hytale format project to be active.",
    annotations: {
      title: "Get Hytale Format Info",
      readOnlyHint: true,
    },
    parameters: emptyParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_validate_model",
    condition: { project: true, method: () => isHytalePluginInstalled() && isHytaleFormat() },
    description:
      "Checks exported main-model node count using the installed Hytale codec and verifies bitmap dimensions are multiples of 32. Does not validate attachment exports, shading, all UVs, animation integration or target-engine rendering.",
    annotations: {
      title: "Validate Hytale Model",
      readOnlyHint: true,
    },
    parameters: emptyParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_set_cube_properties",
    condition: { project: true, method: () => isHytalePluginInstalled() && isHytaleFormat() },
    description:
      "Sets Hytale-specific properties on a cube: shading_mode (flat, standard, fullbright, reflective) and double_sided.",
    annotations: {
      title: "Set Hytale Cube Properties",
      destructiveHint: false,
    },
    parameters: hytaleSetCubePropertiesParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_get_cube_properties",
    condition: { project: true, method: () => isHytalePluginInstalled() && isHytaleFormat() },
    description: "Gets Hytale-specific properties from a cube (shading_mode, double_sided).",
    annotations: {
      title: "Get Hytale Cube Properties",
      readOnlyHint: true,
    },
    parameters: hytaleGetCubePropertiesParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_create_quad",
    condition: { project: true, method: () => isHytalePluginInstalled() && isHytaleFormat() },
    description:
      "Creates a Hytale quad with exactly one enabled face matching the signed normal direction, per-face UV and Auto UV 1. Positive width/height and parent references are validated before one reversible edit.",
    annotations: {
      title: "Create Hytale Quad",
      destructiveHint: false,
    },
    parameters: hytaleCreateQuadParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_list_attachments",
    condition: { project: true, method: () => isHytalePluginInstalled() && isHytaleFormat() },
    description: "Lists all attachment collections in the current Hytale project.",
    annotations: {
      title: "List Hytale Attachments",
      readOnlyHint: true,
    },
    parameters: emptyParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_set_attachment_piece",
    condition: { project: true, method: () => isHytalePluginInstalled() && isHytaleFormat() },
    description:
      "Marks or unmarks a group as an attachment piece. Attachment pieces attach to like-named bones in the main model.",
    annotations: {
      title: "Set Attachment Piece",
      destructiveHint: false,
    },
    parameters: hytaleSetAttachmentPieceParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_list_attachment_pieces",
    condition: { project: true, method: () => isHytalePluginInstalled() && isHytaleFormat() },
    description: "Lists all groups marked as attachment pieces.",
    annotations: {
      title: "List Attachment Pieces",
      readOnlyHint: true,
    },
    parameters: emptyParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_create_visibility_keyframe",
    condition: { project: true, method: () => isHytalePluginInstalled() && isHytaleFormat() },
    description:
      "Creates a visibility keyframe for a bone. Hytale supports toggling node visibility at keyframes.",
    annotations: {
      title: "Create Visibility Keyframe",
      destructiveHint: false,
    },
    parameters: hytaleCreateVisibilityKeyframeParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_set_animation_loop",
    condition: { project: true, method: () => isHytalePluginInstalled() && isHytaleFormat() },
    description:
      'Sets the loop mode for a Hytale animation. Hytale supports "loop" (continuous) or "hold" (freeze on last frame).',
    annotations: {
      title: "Set Animation Loop Mode",
      destructiveHint: false,
    },
    parameters: hytaleSetAnimationLoopParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_set_cube_stretch",
    condition: { project: true, method: () => isHytalePluginInstalled() && isHytaleFormat() },
    description:
      "Sets the stretch values for a cube. Hytale uses stretch instead of float sizes for better UV handling.",
    annotations: {
      title: "Set Cube Stretch",
      destructiveHint: false,
    },
    parameters: hytaleSetCubeStretchParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_get_cube_stretch",
    condition: { project: true, method: () => isHytalePluginInstalled() && isHytaleFormat() },
    description: "Gets the stretch values for a cube.",
    annotations: {
      title: "Get Cube Stretch",
      readOnlyHint: true,
    },
    parameters: hytaleGetCubeStretchParametersSchema,
    status: "experimental",
  },
];

/** Native Hytale quad face polarity and width/height axes for each requested normal. */
const quadDirections: Record<z.infer<typeof hytaleQuadNormalEnum>, { face: CubeFaceDirection; axes: readonly [number, number] }> = {
  "+X": { face: "east", axes: [2, 1] }, "-X": { face: "west", axes: [2, 1] },
  "+Y": { face: "up", axes: [0, 2] }, "-Y": { face: "down", axes: [0, 2] },
  "+Z": { face: "south", axes: [0, 1] }, "-Z": { face: "north", axes: [0, 1] },
};

/** Native disabled faces use null, which the published CubeFace.texture declaration omits. */
type QuadFaceTexture = { texture: CubeFace["texture"] | null };

/** Resolves a quad's parent by UUID first, rejecting names that could target multiple bones. */
function quadParent(reference: string | undefined): Group | "root" {
  if (reference === undefined || reference === "root") return "root";
  const byUuid = Group.all.find(group => group.uuid === reference);
  if (byUuid) return byUuid;
  const matches = Group.all.filter(group => group.name === reference);
  if (matches.length === 0) throw new Error(`Parent group "${reference}" not found. Use list_outline to inspect group UUIDs and names.`);
  if (matches.length > 1) throw new Error(`Parent group name "${reference}" is ambiguous. Use its UUID.`);
  return matches[0];
}

/** Creates a native single-face Hytale quad, recording its bitmap-independent geometry before initialization. */
async function createHytaleQuad({ name, position, normal, size, group, double_sided }: z.infer<typeof hytaleCreateQuadParametersSchema>): Promise<string> {
  if (typeof Project === "undefined" || !Project || !isHytaleFormat()) throw new Error("Open a Hytale format project before creating a quad.");
  if (position.some(value => !Number.isFinite(value))) throw new Error("Quad position must contain finite numbers.");
  if (size.some(value => !Number.isFinite(value) || value <= 0)) throw new Error("Quad width and height must be finite and positive.");
  const parent = quadParent(group);
  const direction = quadDirections[normal];
  const from = [...position] as [number, number, number];
  const to: [number, number, number] = [...from];
  direction.axes.forEach((axis, dimension) => { to[axis] += size[dimension]; });
  if (to.some(value => !Number.isFinite(value))) throw new Error("Quad bounds must remain finite after adding the size to the position.");
  const texture = Format.single_texture ? Texture.getDefault() : undefined;
  const created: Cube[] = [];
  const cube = runUndoableEdit({ outliner: true, elements: created }, "Create Hytale quad", () => {
    const quad = new Cube({ name, from, to, autouv: 1, box_uv: false });
    created.push(quad);
    quad.box_uv = false;
    Object.entries(quad.faces).forEach(([face, data]) => {
      (data as QuadFaceTexture).texture = face === direction.face ? texture?.uuid ?? false : null;
    });
    const hytaleQuad = quad as IHytaleCube;
    hytaleQuad.double_sided = double_sided;
    hytaleQuad.shading_mode = "standard";
    quad.init().addTo(parent);
    if (quad.parent !== parent) throw new Error("The current format does not allow the requested quad parent.");
    quad.mapAutoUV();
    Canvas.updateAll();
    return quad;
  });
  return JSON.stringify({ uuid: cube.uuid, name: cube.name, normal, from, to, double_sided });
}

/**
 * Register Hytale-specific tools.
 * These tools are only functional when the Hytale plugin is installed.
 */
export function registerHytaleTools() {
  // Keep definitions registered so native conditions can enable them when the
  // Hytale plugin is loaded after MCP, or disable them when it is unloaded.

  // ============================================================================
  // Format & Project Tools
  // ============================================================================

  createTool(
    hytaleToolDocs[0].name,
    {
      ...hytaleToolDocs[0],
      async execute() {
        if (!isHytaleFormat()) {
          throw new Error(
            "Current project is not using a Hytale format. Create or open a Hytale character or prop project first."
          );
        }

        const formatType = getHytaleFormatType();
        const blockSize = getHytaleBlockSize();
        const nodeValidation = validateNodeCount();

        return JSON.stringify({
          formatType,
          blockSize,
          animationFPS: getHytaleAnimationFPS(),
          nodeCount: nodeValidation.count,
          maxNodes: nodeValidation.max,
          nodeCountValid: nodeValidation.valid,
          features: {
            boneRig: true,
            animationFiles: true,
            quaternionInterpolation: true,
            uvRotation: true,
            stretchCubes: true,
            attachments: true,
            quads: true,
          },
        });
      },
    },
    hytaleToolDocs[0].status
  );

  createTool(
    hytaleToolDocs[1].name,
    {
      ...hytaleToolDocs[1],
      async execute() {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        const nodeValidation = validateNodeCount();
        const issues: string[] = [];

        if (!nodeValidation.valid) {
          issues.push(nodeValidation.message!);
        }

        const textures = Project?.textures ?? [];
        const blockSize = getHytaleBlockSize();
        issues.push(...getHytaleTextureDimensionIssues(textures));

        return JSON.stringify({
          valid: issues.length === 0,
          nodeCount: nodeValidation.count,
          maxNodes: nodeValidation.max,
          issues,
          blockSize,
          textureCount: textures.length,
          scope: "main_model_node_count_and_texture_dimensions",
          notes: ["Node count comes from the installed blockymodel codec's main-model output. Validate attachment exports separately. Passing these checks does not prove full runtime compatibility."],
        });
      },
    },
    hytaleToolDocs[1].status
  );

  // ============================================================================
  // Cube Property Tools (Shading Mode, Double-Sided)
  // ============================================================================

  createTool(
    hytaleToolDocs[2].name,
    {
      ...hytaleToolDocs[2],
      async execute({ cube_id, shading_mode, double_sided }) {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        let cube: Cube;
        if (cube_id) {
          const element = findElementOrThrow(cube_id);
          if (!(element instanceof Cube)) {
            throw new Error(`Element "${cube_id}" is not a cube.`);
          }
          cube = element;
        } else {
          // @ts-ignore - Cube is globally available
          const selected = Cube.selected[0];
          if (!selected) {
            throw new Error("No cube selected and no cube_id provided.");
          }
          cube = selected;
        }

        // @ts-ignore - Undo is globally available
        Undo.initEdit({ elements: [cube] });

        const hytaleCube = cube as IHytaleCube;
        if (shading_mode !== undefined) {
          hytaleCube.shading_mode = shading_mode;
        }
        if (double_sided !== undefined) {
          hytaleCube.double_sided = double_sided;
        }

        // @ts-ignore - Undo is globally available
        Undo.finishEdit("Set Hytale cube properties");

        return JSON.stringify({
          uuid: cube.uuid,
          name: cube.name,
          shading_mode: getCubeShadingMode(cube),
          double_sided: isCubeDoubleSided(cube),
        });
      },
    },
    hytaleToolDocs[2].status
  );

  createTool(
    hytaleToolDocs[3].name,
    {
      ...hytaleToolDocs[3],
      async execute({ cube_id }) {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        let cube: Cube;
        if (cube_id) {
          const element = findElementOrThrow(cube_id);
          if (!(element instanceof Cube)) {
            throw new Error(`Element "${cube_id}" is not a cube.`);
          }
          cube = element;
        } else {
          // @ts-ignore - Cube is globally available
          const selected = Cube.selected[0];
          if (!selected) {
            throw new Error("No cube selected and no cube_id provided.");
          }
          cube = selected;
        }

        return JSON.stringify({
          uuid: cube.uuid,
          name: cube.name,
          shading_mode: getCubeShadingMode(cube),
          double_sided: isCubeDoubleSided(cube),
        });
      },
    },
    hytaleToolDocs[3].status
  );

  // ============================================================================
  // Quad Creation Tool
  // ============================================================================

  createTool(
    hytaleToolDocs[4].name,
    {
      ...hytaleToolDocs[4],
      parameters: hytaleCreateQuadParametersSchema,
      execute: createHytaleQuad,
    },
    hytaleToolDocs[4].status
  );

  // ============================================================================
  // Attachment Tools
  // ============================================================================

  createTool(
    hytaleToolDocs[5].name,
    {
      ...hytaleToolDocs[5],
      async execute() {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        const attachments = getAttachmentCollections();

        return JSON.stringify({
          count: attachments.length,
          attachments: attachments.map((a) => ({
            uuid: a.uuid,
            name: a.name,
            texture: a.texture ?? null,
            // @ts-ignore - children may exist on collection
            elementCount: a.children?.length ?? 0,
          })),
        });
      },
    },
    hytaleToolDocs[5].status
  );

  createTool(
    hytaleToolDocs[6].name,
    {
      ...hytaleToolDocs[6],
      async execute({ group_name, is_piece }) {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        const group = findGroupOrThrow(group_name);

        // @ts-ignore - Undo is globally available
        Undo.initEdit({ outliner: true });

        (group as IHytaleGroup).is_piece = is_piece;

        // @ts-ignore - Undo is globally available
        Undo.finishEdit("Set attachment piece");

        return JSON.stringify({
          uuid: group.uuid,
          name: group.name,
          is_piece,
        });
      },
    },
    hytaleToolDocs[6].status
  );

  createTool(
    hytaleToolDocs[7].name,
    {
      ...hytaleToolDocs[7],
      async execute() {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        const pieces = getAttachmentPieces();

        return JSON.stringify({
          count: pieces.length,
          pieces: pieces.map((p) => ({
            uuid: p.uuid,
            name: p.name,
            origin: p.origin,
          })),
        });
      },
    },
    hytaleToolDocs[7].status
  );

  // ============================================================================
  // Animation Tools (Hytale-specific features)
  // ============================================================================

  createTool(
    hytaleToolDocs[8].name,
    {
      ...hytaleToolDocs[8],
      parameters: hytaleCreateVisibilityKeyframeParametersSchema,
      async execute({ bone_name, time, visible, animation_id }) {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        if (!Number.isFinite(time) || time < 0 || time > 10000) throw new Error("Visibility keyframe time must be finite and between 0 and 10000 seconds.");
        const animation = findAnimationOrSelected(animation_id);
        if (!animation) throw new Error(animation_id ? `Animation "${animation_id}" not found.` : "No animation selected and no animation_id provided.");
        const bone = findGroupOrThrow(bone_name);
        const keyframe = runUndoableAnimationEdit({ animations: [animation] }, "Create visibility keyframe", () => {
          const animator = animation.getBoneAnimator(bone);
          if (!animator) throw new Error(`Could not get animator for bone "${bone_name}".`);
          const frame: _Keyframe | undefined = animator.addKeyframe({ channel: "visibility", time, data_points: [{ visible }] });
          if (!frame) throw new Error("The Hytale animator could not create a visibility keyframe.");
          if (typeof updateKeyframeSelection === "function") updateKeyframeSelection();
          return frame;
        });

        return JSON.stringify({
          success: true,
          animation: animation.name,
          bone: bone_name,
          time,
          visible,
          keyframe_uuid: keyframe.uuid,
        });
      },
    },
    hytaleToolDocs[8].status
  );

  createTool(
    hytaleToolDocs[9].name,
    {
      ...hytaleToolDocs[9],
      parameters: hytaleSetAnimationLoopParametersSchema,
      async execute({ animation_id, loop_mode }) {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        const animation = findAnimationOrSelected(animation_id);
        if (!animation) throw new Error(animation_id ? `Animation "${animation_id}" not found.` : "No animation selected and no animation_id provided.");
        runUndoableAnimationEdit({ animations: [animation] }, "Set animation loop mode", () => { animation.loop = loop_mode; });

        return JSON.stringify({
          animation: animation.name,
          uuid: animation.uuid,
          loop_mode,
        });
      },
    },
    hytaleToolDocs[9].status
  );

  // ============================================================================
  // Stretch Tool (Hytale-specific cube stretching)
  // ============================================================================

  createTool(
    hytaleToolDocs[10].name,
    {
      ...hytaleToolDocs[10],
      async execute({ cube_id, stretch }) {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        let cube: Cube;
        if (cube_id) {
          const element = findElementOrThrow(cube_id);
          if (!(element instanceof Cube)) {
            throw new Error(`Element "${cube_id}" is not a cube.`);
          }
          cube = element;
        } else {
          // @ts-ignore - Cube is globally available
          const selected = Cube.selected[0];
          if (!selected) {
            throw new Error("No cube selected and no cube_id provided.");
          }
          cube = selected;
        }

        // @ts-ignore - Undo is globally available
        Undo.initEdit({ elements: [cube] });

        // @ts-ignore - stretch property on cube
        cube.stretch = [...stretch];

        // @ts-ignore - Undo is globally available
        Undo.finishEdit("Set cube stretch");

        // @ts-ignore - Canvas is globally available
        Canvas.updateAll();

        return JSON.stringify({
          uuid: cube.uuid,
          name: cube.name,
          stretch,
        });
      },
    },
    hytaleToolDocs[10].status
  );

  createTool(
    hytaleToolDocs[11].name,
    {
      ...hytaleToolDocs[11],
      async execute({ cube_id }) {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        let cube: Cube;
        if (cube_id) {
          const element = findElementOrThrow(cube_id);
          if (!(element instanceof Cube)) {
            throw new Error(`Element "${cube_id}" is not a cube.`);
          }
          cube = element;
        } else {
          // @ts-ignore - Cube is globally available
          const selected = Cube.selected[0];
          if (!selected) {
            throw new Error("No cube selected and no cube_id provided.");
          }
          cube = selected;
        }

        // @ts-ignore - stretch property on cube
        const stretch = cube.stretch ?? [1, 1, 1];

        return JSON.stringify({
          uuid: cube.uuid,
          name: cube.name,
          stretch,
        });
      },
    },
    hytaleToolDocs[11].status
  );

  console.log("[MCP] Hytale tools registered successfully");
}
