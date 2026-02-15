/// <reference types="three" />
/// <reference types="blockbench-types" />

import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import {
  isHytalePluginInstalled,
  isHytaleFormat,
  getHytaleFormatType,
  getHytaleBlockSize,
  getAttachmentCollections,
  findAttachmentCollection,
  getAttachmentPieces,
  getCubeShadingMode,
  isCubeDoubleSided,
  validateNodeCount,
  getHytaleAnimationFPS,
  HYTALE_SHADING_MODES,
  HYTALE_QUAD_NORMALS,
  type HytaleCube,
  type HytaleGroup,
  type HytaleAttachmentCollection,
} from "@/lib/hytale";
import { findGroupOrThrow, findElementOrThrow } from "@/lib/util";
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
  position: vector3Schema.default([0, 0, 0]).describe("Position [x, y, z]"),
  normal: hytaleQuadNormalEnum
    .default("+Y")
    .describe("Normal direction: +X, -X, +Y, -Y, +Z, -Z"),
  size: size2dSchema.default([16, 16]),
  group: groupIdOptionalSchema.describe("Parent group/bone name"),
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
  time: z.number().describe("Time in seconds for the keyframe"),
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

export const hytaleToolDocs: ToolSpec[] = [
  {
    name: "hytale_get_format_info",
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
    description:
      "Validates the current Hytale model against Hytale engine constraints (node count, UV sizes, etc.).",
    annotations: {
      title: "Validate Hytale Model",
      readOnlyHint: true,
    },
    parameters: emptyParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_set_cube_properties",
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
    description:
      "Creates a Hytale quad (2D plane) with a specified normal direction. Quads are single-face elements useful for flat surfaces.",
    annotations: {
      title: "Create Hytale Quad",
      destructiveHint: false,
    },
    parameters: hytaleCreateQuadParametersSchema,
    status: "experimental",
  },
  {
    name: "hytale_list_attachments",
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
    description: "Gets the stretch values for a cube.",
    annotations: {
      title: "Get Cube Stretch",
      readOnlyHint: true,
    },
    parameters: hytaleGetCubeStretchParametersSchema,
    status: "experimental",
  },
];

/**
 * Register Hytale-specific tools.
 * These tools are only functional when the Hytale plugin is installed.
 */
export function registerHytaleTools() {
  // Only register if Hytale plugin is available
  if (!isHytalePluginInstalled()) {
    console.log("[MCP] Hytale plugin not detected, skipping Hytale tools registration");
    return;
  }

  console.log("[MCP] Hytale plugin detected, registering Hytale tools");

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

        // Check UV size matches texture resolution
        // @ts-ignore - Project is globally available
        const textures = Project?.textures ?? [];
        const blockSize = getHytaleBlockSize();

        for (const texture of textures) {
          if (texture.width !== blockSize || texture.height < blockSize) {
            // Check for flipbook (vertically stacked frames)
            if (texture.height % blockSize !== 0) {
              issues.push(
                `Texture "${texture.name}" has invalid dimensions (${texture.width}x${texture.height}). Expected width ${blockSize} and height multiple of ${blockSize}.`
              );
            }
          }
        }

        return JSON.stringify({
          valid: issues.length === 0,
          nodeCount: nodeValidation.count,
          maxNodes: nodeValidation.max,
          issues,
          blockSize,
          textureCount: textures.length,
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

        const hytaleCube = cube as HytaleCube;
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
      async execute({ name, position, normal, size, group, double_sided }) {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        // Find parent group if specified
        let parentGroup: Group | undefined;
        if (group) {
          parentGroup = findGroupOrThrow(group);
        }

        // Calculate from/to based on normal direction and size
        const [width, height] = size;
        const [x, y, z] = position;
        let from: [number, number, number];
        let to: [number, number, number];

        // Quads are essentially very thin cubes (0 depth in one dimension)
        switch (normal) {
          case "+X":
          case "-X":
            from = [x, y, z];
            to = [x, y + height, z + width];
            break;
          case "+Y":
          case "-Y":
            from = [x, y, z];
            to = [x + width, y, z + height];
            break;
          case "+Z":
          case "-Z":
            from = [x, y, z];
            to = [x + width, y + height, z];
            break;
          default:
            from = [x, y, z];
            to = [x + width, y + height, z];
        }

        // @ts-ignore - Undo is globally available
        Undo.initEdit({ outliner: true, elements: [] });

        // @ts-ignore - Cube is globally available
        const cube = new Cube({
          name,
          from,
          to,
          autouv: 1,
        }).init();

        // Set Hytale-specific properties
        const hytaleCube = cube as HytaleCube;
        hytaleCube.double_sided = double_sided;
        hytaleCube.shading_mode = "standard";

        // Add to parent group if specified
        if (parentGroup) {
          cube.addTo(parentGroup);
        }

        // @ts-ignore - Undo is globally available
        Undo.finishEdit("Create Hytale quad");

        // @ts-ignore - Canvas is globally available
        Canvas.updateAll();

        return JSON.stringify({
          uuid: cube.uuid,
          name: cube.name,
          normal,
          from,
          to,
          double_sided,
        });
      },
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

        (group as HytaleGroup).is_piece = is_piece;

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
      async execute({ bone_name, time, visible, animation_id }) {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        // Find animation
        // @ts-ignore - Animation is globally available
        let animation: Animation;
        if (animation_id) {
          // @ts-ignore - Animation is globally available
          animation = Animation.all.find(
            (a: Animation) => a.uuid === animation_id || a.name === animation_id
          );
          if (!animation) {
            throw new Error(`Animation "${animation_id}" not found.`);
          }
        } else {
          // @ts-ignore - Animation is globally available
          animation = Animation.selected;
          if (!animation) {
            throw new Error("No animation selected and no animation_id provided.");
          }
        }

        // Find bone animator
        const animator = animation.getBoneAnimator(findGroupOrThrow(bone_name));
        if (!animator) {
          throw new Error(`Could not get animator for bone "${bone_name}".`);
        }

        // @ts-ignore - Undo is globally available
        Undo.initEdit({ animations: [animation] });

        // Create visibility keyframe
        // Hytale uses a "visibility" channel for BoneAnimator
        // @ts-ignore - addKeyframe may have visibility channel
        const keyframe = animator.addKeyframe({
          channel: "visibility",
          time,
          data_points: [{ visible }],
        });

        // @ts-ignore - Undo is globally available
        Undo.finishEdit("Create visibility keyframe");

        // @ts-ignore - updateKeyframeSelection may exist
        if (typeof updateKeyframeSelection === "function") {
          updateKeyframeSelection();
        }

        return JSON.stringify({
          success: true,
          animation: animation.name,
          bone: bone_name,
          time,
          visible,
          keyframe_uuid: keyframe?.uuid,
        });
      },
    },
    hytaleToolDocs[8].status
  );

  createTool(
    hytaleToolDocs[9].name,
    {
      ...hytaleToolDocs[9],
      async execute({ animation_id, loop_mode }) {
        if (!isHytaleFormat()) {
          throw new Error("Current project is not using a Hytale format.");
        }

        // Find animation
        // @ts-ignore - Animation is globally available
        let animation: Animation;
        if (animation_id) {
          // @ts-ignore - Animation is globally available
          animation = Animation.all.find(
            (a: Animation) => a.uuid === animation_id || a.name === animation_id
          );
          if (!animation) {
            throw new Error(`Animation "${animation_id}" not found.`);
          }
        } else {
          // @ts-ignore - Animation is globally available
          animation = Animation.selected;
          if (!animation) {
            throw new Error("No animation selected and no animation_id provided.");
          }
        }

        // @ts-ignore - Undo is globally available
        Undo.initEdit({ animations: [animation] });

        animation.loop = loop_mode;

        // @ts-ignore - Undo is globally available
        Undo.finishEdit("Set animation loop mode");

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
