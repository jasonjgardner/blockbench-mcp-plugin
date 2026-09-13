import { z } from "zod";
import {
  vector3Schema,
  animationIdOptionalSchema,
  animationChannelEnum,
  axisEnum,
  axisWithAllEnum,
  timeRangeSchema,
  boneNameSchema,
  loopModeEnum,
  keyframeDataSchema,
} from "@/lib/zodObjects";

/**
 * Longest animation, in seconds, a tool may create or set. Bounds runaway
 * timelines that would make Blockbench's timeline UI and baking unusable.
 */
const MAX_ANIMATION_LENGTH_SECONDS = 10000;

/** Lowest timeline snapping rate Blockbench accepts for an animation. */
const MIN_TIMELINE_FPS = 10;

/** Highest timeline snapping rate exposed to agents. */
const MAX_TIMELINE_FPS = 120;

/** Native Blockbench animation data; rotations are degrees in editor coordinates. */
export const createAnimationParameters = z.object({
  name: z.string().describe("Name of the animation"),
  loop: z
    .boolean()
    .default(false)
    .describe("Whether the animation should loop"),
  animation_length: z
    .number()
    .finite()
    .nonnegative()
    .max(MAX_ANIMATION_LENGTH_SECONDS)
    .optional()
    .describe("Length of the animation in seconds"),
  bones: z
    .record(
      z.array(
        z.object({
          time: z.number().finite().nonnegative(),
          position: vector3Schema.optional(),
          rotation: vector3Schema.optional(),
          scale: z.union([vector3Schema, z.number()]).optional(),
        })
      )
    )
    .describe("Keyframes keyed by existing bone/group name. Values use Blockbench editor coordinates; rotations are degrees."),
  particle_effects: z
    .record(z.string().describe("Effect name"))
    .optional()
    .describe("Particle effects with timestamps as keys"),
});

/**
 * Input for `manage_keyframes`: one action applied to keyframes of a single
 * bone channel, matched by time within the target (or selected) animation.
 */
export const manageKeyframesParameters = z.object({
  animation_id: animationIdOptionalSchema,
  action: z
    .enum(["create", "delete", "edit", "select"])
    .describe("Action to perform on keyframes."),
  bone_name: boneNameSchema.describe("Name of the bone/group to manage keyframes for."),
  channel: animationChannelEnum.describe("Animation channel to modify."),
  keyframes: z
    .array(keyframeDataSchema)
    .describe("Keyframe data for the action."),
});

/**
 * Input for `animation_graph_editor`: an interpolation preset or custom bezier
 * curve applied to one bone channel, optionally limited to a time range.
 */
export const animationGraphEditorParameters = z.object({
  animation_id: animationIdOptionalSchema,
  bone_name: boneNameSchema.describe("Name of the bone/group to modify curves for."),
  channel: animationChannelEnum.describe("Animation channel to modify."),
  axis: axisWithAllEnum.default("all").describe("Axis to modify curves for."),
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
  keyframe_range: timeRangeSchema
    .optional()
    .describe(
      "Time range to apply the curve modification. If not provided, applies to all keyframes."
    ),
  custom_curve: z
    .object({
      control_point_1: z
        .array(z.number())
        .length(2)
        .describe("First control point [time, value]."),
      control_point_2: z
        .array(z.number())
        .length(2)
        .describe("Second control point [time, value]."),
    })
    .optional()
    .describe(
      "Custom bezier curve control points (only for 'custom' action)."
    ),
});

/**
 * Input for `bone_rigging`: one outliner action on a bone (Blockbench group).
 *
 * `bone_data.name` always identifies the bone being acted on, except for
 * `create`, where it names the new bone. The remaining fields are
 * action-specific: `parent`/`children` drive `create` and `parent` (for
 * `rename`, `children[0]` is the new name), `origin`/`rotation` feed `create`
 * and `set_pivot`, `ik_enabled`/`ik_target` feed `create` and `set_ik`, and
 * `mirror_axis` selects the axis for `mirror`.
 */
export const boneRiggingParameters = z.object({
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
      parent: z.string().optional().describe("Parent bone name; create also accepts a group UUID or root."),
      origin: vector3Schema.optional().describe("Pivot point of the bone."),
      rotation: vector3Schema.optional().describe("Initial rotation of the bone."),
      children: z
        .array(z.string())
        .optional()
        .describe("Names or UUIDs of existing elements/groups to add when creating a bone. For rename, the first entry is the new name."),
      ik_enabled: z
        .boolean()
        .optional()
        .describe("Enable inverse kinematics for this bone."),
      ik_target: z
        .string()
        .optional()
        .describe("Target bone for IK chain."),
      mirror_axis: axisEnum.optional().describe("Axis to mirror the bone across."),
    })
    .describe("Bone configuration data."),
});

/** Playback targets an explicit animation or falls back to the selected animation. */
export const animationTimelineParameters = z.object({
  animation_id: animationIdOptionalSchema,
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
    .finite()
    .nonnegative()
    .optional()
    .describe("Time in seconds (for set_time action)."),
  length: z
    .number()
    .finite()
    .nonnegative()
    .max(MAX_ANIMATION_LENGTH_SECONDS)
    .optional()
    .describe("Animation length in seconds, including all keyframes (for set_length action)."),
  fps: z
    .number()
    .int()
    .min(MIN_TIMELINE_FPS)
    .max(MAX_TIMELINE_FPS)
    .optional()
    .describe("Integer frames per second, 10–120 (for set_fps action; Blockbench minimum is 10)."),
  loop_mode: loopModeEnum.optional().describe("Loop mode for the animation."),
  range: timeRangeSchema.optional().describe("Time range for selection."),
});

/**
 * Input for `batch_keyframe_operations`: a keyframe selection strategy plus
 * one timing/value operation and its operation-specific parameters.
 */
export const batchKeyframeOperationsParameters = z.object({
  selection: z
    .enum(["all", "selected", "range", "pattern"])
    .default("selected")
    .describe("Which keyframes to operate on."),
  range: timeRangeSchema.optional().describe("Time range for keyframe selection."),
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
      offset_values: vector3Schema.optional().describe("Value offset to apply."),
      scale_factor: z
        .number()
        .optional()
        .describe("Scale factor for time or values."),
      scale_pivot: z
        .number()
        .optional()
        .describe("Pivot point for scaling."),
      mirror_axis: axisEnum.optional().describe("Axis to mirror values across."),
      bake_interval: z
        .number()
        .optional()
        .describe("Interval for baking keyframes."),
    })
    .optional()
    .describe("Operation-specific parameters."),
});

/**
 * Input for `animation_copy_paste`: `copy` reads `source` into the shared
 * animation clipboard; `paste`/`mirror_paste` write it to `target`.
 */
export const animationCopyPasteParameters = z.object({
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
        .array(animationChannelEnum)
        .optional()
        .default(["rotation", "position", "scale"])
        .describe("Channels to copy."),
      time_range: timeRangeSchema
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
      mirror_axis: axisEnum.optional().describe("Axis to mirror across for mirror_paste."),
    })
    .optional()
    .describe("Target data for paste operation."),
});
