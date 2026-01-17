/// <reference types="three" />
/// <reference types="blockbench-types" />

import { z } from "zod";
import { createTool } from "@/lib/factories";
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
    "hytale_get_format_info",
    {
      description:
        "Returns information about the current Hytale format. Requires the Hytale plugin and a Hytale format project to be active.",
      annotations: {
        title: "Get Hytale Format Info",
        readOnlyHint: true,
      },
      parameters: z.object({}),
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
    "experimental"
  );

  createTool(
    "hytale_validate_model",
    {
      description:
        "Validates the current Hytale model against Hytale engine constraints (node count, UV sizes, etc.).",
      annotations: {
        title: "Validate Hytale Model",
        readOnlyHint: true,
      },
      parameters: z.object({}),
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
    "experimental"
  );

  // ============================================================================
  // Cube Property Tools (Shading Mode, Double-Sided)
  // ============================================================================

  createTool(
    "hytale_set_cube_properties",
    {
      description:
        "Sets Hytale-specific properties on a cube: shading_mode (flat, standard, fullbright, reflective) and double_sided.",
      annotations: {
        title: "Set Hytale Cube Properties",
        destructiveHint: false,
      },
      parameters: z.object({
        cube_id: z
          .string()
          .describe("ID or name of the cube to modify. Uses selected cube if not provided.")
          .optional(),
        shading_mode: z
          .enum(HYTALE_SHADING_MODES)
          .describe("Shading mode: flat (no lighting), standard (normal), fullbright (emissive), reflective")
          .optional(),
        double_sided: z
          .boolean()
          .describe("Whether to render both sides of faces")
          .optional(),
      }),
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
    "experimental"
  );

  createTool(
    "hytale_get_cube_properties",
    {
      description: "Gets Hytale-specific properties from a cube (shading_mode, double_sided).",
      annotations: {
        title: "Get Hytale Cube Properties",
        readOnlyHint: true,
      },
      parameters: z.object({
        cube_id: z
          .string()
          .describe("ID or name of the cube. Uses selected cube if not provided.")
          .optional(),
      }),
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
    "experimental"
  );

  // ============================================================================
  // Quad Creation Tool
  // ============================================================================

  createTool(
    "hytale_create_quad",
    {
      description:
        "Creates a Hytale quad (2D plane) with a specified normal direction. Quads are single-face elements useful for flat surfaces.",
      annotations: {
        title: "Create Hytale Quad",
        destructiveHint: false,
      },
      parameters: z.object({
        name: z.string().describe("Name for the quad"),
        position: z
          .array(z.number())
          .length(3)
          .describe("Position [x, y, z]")
          .default([0, 0, 0]),
        normal: z
          .enum(HYTALE_QUAD_NORMALS)
          .describe("Normal direction: +X, -X, +Y, -Y, +Z, -Z")
          .default("+Y"),
        size: z
          .array(z.number())
          .length(2)
          .describe("Size [width, height]")
          .default([16, 16]),
        group: z
          .string()
          .describe("Parent group/bone name")
          .optional(),
        double_sided: z
          .boolean()
          .describe("Whether to render both sides")
          .default(true),
      }),
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
    "experimental"
  );

  // ============================================================================
  // Attachment Tools
  // ============================================================================

  createTool(
    "hytale_list_attachments",
    {
      description: "Lists all attachment collections in the current Hytale project.",
      annotations: {
        title: "List Hytale Attachments",
        readOnlyHint: true,
      },
      parameters: z.object({}),
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
    "experimental"
  );

  createTool(
    "hytale_set_attachment_piece",
    {
      description:
        "Marks or unmarks a group as an attachment piece. Attachment pieces attach to like-named bones in the main model.",
      annotations: {
        title: "Set Attachment Piece",
        destructiveHint: false,
      },
      parameters: z.object({
        group_name: z.string().describe("Name of the group to mark as attachment piece"),
        is_piece: z.boolean().describe("Whether the group is an attachment piece"),
      }),
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
    "experimental"
  );

  createTool(
    "hytale_list_attachment_pieces",
    {
      description: "Lists all groups marked as attachment pieces.",
      annotations: {
        title: "List Attachment Pieces",
        readOnlyHint: true,
      },
      parameters: z.object({}),
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
    "experimental"
  );

  // ============================================================================
  // Animation Tools (Hytale-specific features)
  // ============================================================================

  createTool(
    "hytale_create_visibility_keyframe",
    {
      description:
        "Creates a visibility keyframe for a bone. Hytale supports toggling node visibility at keyframes.",
      annotations: {
        title: "Create Visibility Keyframe",
        destructiveHint: false,
      },
      parameters: z.object({
        bone_name: z.string().describe("Name of the bone/group"),
        time: z.number().describe("Time in seconds for the keyframe"),
        visible: z.boolean().describe("Whether the bone is visible at this keyframe"),
        animation_id: z
          .string()
          .describe("Animation UUID or name. Uses current animation if not provided.")
          .optional(),
      }),
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
    "experimental"
  );

  createTool(
    "hytale_set_animation_loop",
    {
      description:
        'Sets the loop mode for a Hytale animation. Hytale supports "loop" (continuous) or "hold" (freeze on last frame).',
      annotations: {
        title: "Set Animation Loop Mode",
        destructiveHint: false,
      },
      parameters: z.object({
        animation_id: z
          .string()
          .describe("Animation UUID or name. Uses current animation if not provided.")
          .optional(),
        loop_mode: z
          .enum(["loop", "hold", "once"])
          .describe("Loop mode: loop (continuous), hold (freeze on last frame), once (play once)"),
      }),
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
    "experimental"
  );

  // ============================================================================
  // Stretch Tool (Hytale-specific cube stretching)
  // ============================================================================

  createTool(
    "hytale_set_cube_stretch",
    {
      description:
        "Sets the stretch values for a cube. Hytale uses stretch instead of float sizes for better UV handling.",
      annotations: {
        title: "Set Cube Stretch",
        destructiveHint: false,
      },
      parameters: z.object({
        cube_id: z
          .string()
          .describe("ID or name of the cube. Uses selected cube if not provided.")
          .optional(),
        stretch: z
          .array(z.number())
          .length(3)
          .describe("Stretch values [x, y, z]"),
      }),
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
    "experimental"
  );

  createTool(
    "hytale_get_cube_stretch",
    {
      description: "Gets the stretch values for a cube.",
      annotations: {
        title: "Get Cube Stretch",
        readOnlyHint: true,
      },
      parameters: z.object({
        cube_id: z
          .string()
          .describe("ID or name of the cube. Uses selected cube if not provided.")
          .optional(),
      }),
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
    "experimental"
  );

  console.log("[MCP] Hytale tools registered successfully");
}
