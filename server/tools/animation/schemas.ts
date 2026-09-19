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
  axis: axisWithAllEnum.default("all").describe("Axes to edit. Linear, stepped and smooth require all because interpolation is key-wide. Partial-axis easing/custom edits require selected keys already using Bezier interpolation, preserving other axes' handles."),
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
    .describe("Curve modification. Easing/custom require at least two distinct chronological numeric single-data-point keys. Smooth and Bezier rotation edits are unavailable when native quaternion interpolation would ignore them."),
  keyframe_range: timeRangeSchema
    .optional()
    .describe(
      "Finite ordered time range selecting existing keys; omitted means the full channel. Key-wide interpolation can affect neighboring segments at range boundaries, so edit the full channel when boundary continuity matters."
    ),
  custom_curve: z
    .object({
      control_point_1: z
        .array(z.number().finite())
        .length(2)
        .describe("Outgoing normalized control point [time fraction in 0..1, value fraction] for each selected adjacent-key segment. Finite value fractions outside 0..1 allow overshoot."),
      control_point_2: z
        .array(z.number().finite())
        .length(2)
        .describe("Incoming normalized control point [time fraction in 0..1, value fraction], measured from the segment start. Converted to native per-axis offsets relative to the ending key."),
    })
    .optional()
    .describe(
      "Normalized cubic Bezier control points, required for custom action. Conversion uses each segment's duration and edited-axis endpoint values; unrelated axis handles are preserved."
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
        .describe(
          "Deprecated; prefer set_ik_controller. true makes this bone the end effector of a null-object IK controller (created as <bone>_ik when ik_target is omitted); false clears ik_target on controllers driving it."
        ),
      ik_target: z
        .string()
        .optional()
        .describe("Name or UUID of the null object that drives this bone as the IK controller."),
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
      "select_before_playhead",
      "select_after_playhead",
    ])
    .describe("Timeline action to perform. select_before_playhead/select_after_playhead replace the keyframe selection with bone keyframes at or before/after the playhead (1e-5 s tolerance, like Blockbench 5.2's native actions) and return their UUIDs."),
  time: z
    .number()
    .finite()
    .nonnegative()
    .optional()
    .describe("Time in seconds. Required for set_time; for select_before_playhead/select_after_playhead it is the reference time and defaults to the current playhead."),
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
  scope: z
    .enum(["animation", "timeline"])
    .default("animation")
    .describe("Keyframes considered by select_before_playhead/select_after_playhead. animation: every bone animator of the target animation, including ones hidden from the timeline. timeline: only animators shown in the timeline with visible channels, matching the native action; requires the target animation to be selected."),
});

/**
 * Input for `batch_keyframe_operations`: a keyframe selection strategy plus
 * one timing/value operation and its operation-specific parameters.
 */
export const batchKeyframeOperationsParameters = z.object({
  selection: z
    .enum(["all", "selected", "range", "pattern"])
    .default("selected")
    .describe("Which active-animation keyframes to operate on. all includes hidden or collapsed animators."),
  range: timeRangeSchema.optional().describe("Time range for keyframe selection."),
  pattern: z
    .object({
      interval: z.number().finite().positive().describe("Positive time interval between keyframes."),
      offset: z
        .number()
        .finite()
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
      offset_time: z.number().finite().optional().describe("Time offset to apply; resulting keyframes must remain between 0 and 10000 seconds."),
      offset_values: vector3Schema.optional().describe("Numeric [x,y,z] value offset. Requires transform keyframes with a single numeric data point; expressions and pre/post values require native tools."),
      scale_factor: z
        .number()
        .finite()
        .optional()
        .describe("Scale factor for keyframe times around scale_pivot. Does not scale values; zero is accepted only when it creates no timestamp collisions."),
      scale_pivot: z
        .number()
        .finite()
        .optional()
        .describe("Pivot point for scaling."),
      mirror_axis: axisEnum.optional().describe("Numeric component to negate. Requires transform keyframes with a single numeric data point."),
      bake_interval: z
        .number()
        .finite()
        .min(0.001)
        .optional()
        .describe("Sampling interval in seconds (minimum 0.001; at most 10000 samples). Bakes only selected transform channels between their selected times. Requires continuous numeric single-data-point keyframes; expressions, effects and stepped/pre-post curves require native baking."),
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
        .finite()
        .optional()
        .default(0)
        .describe("Offset for exact, unsnapped pasted timestamps; results must remain between 0 and 10000 seconds. Existing keys at the same channel/time are replaced."),
      mirror_axis: axisEnum.optional().describe("Native mirror axis for mirror_paste (default x). Position negates this axis, rotation negates the other two axes, scale is unchanged; curve handles follow native mirroring."),
    })
    .optional()
    .describe("Target data for paste operation."),
});

// The placeholder field schemas below are factories: each use gets a fresh
// instance so the advertised JSON schema stays inlined instead of collapsing
// repeated instances into a bare `$ref` (see issue #44).

/** Placeholder variable names Blockbench's control parser recognizes (`[\w.-]+`). */
const placeholderVariableSchema = () => z
  .string()
  .regex(/^[A-Za-z_][\w.-]*$/, "Use a Molang variable name such as variable.speed or v.speed.")
  .describe("Variable assigned by the line, e.g. variable.speed (v./q./t./c. short prefixes are expanded by Blockbench).");

/** Control labels are quoted inside the call, so quotes, parentheses and commas would break parsing. */
const placeholderControlNameSchema = () => z
  .string()
  .regex(/^[^'"(),\r\n]+$/, "Control names cannot contain quotes, parentheses, commas or line breaks.")
  .describe("Label of the preview control shown in the Variable Placeholders panel.");

/** Optional starting value applied to a new or rebuilt slider/toggle control. */
const placeholderInitialValueSchema = () => z
  .number()
  .finite()
  .optional()
  .describe("Initial control value (toggle: 0 or 1). Preview-only; not saved as text.");

/**
 * One structured placeholder line, mirroring Blockbench 5.2's
 * "Create Variable Placeholder" dialog types.
 */
export const variablePlaceholderEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("value"),
    variable: placeholderVariableSchema(),
    value: z
      .union([z.number().finite(), z.string().min(1).regex(/^[^\r\n]+$/, "Expressions must be a single line.")])
      .describe("Constant number or single-line Molang expression."),
  }),
  z.object({
    type: z.literal("slider"),
    variable: placeholderVariableSchema(),
    name: placeholderControlNameSchema(),
    step: z.number().finite().positive().optional().describe("Slider step; defaults to 1 when a range is given."),
    range: z
      .tuple([z.number().finite(), z.number().finite()])
      .optional()
      .describe("Slider [min, max]."),
    initial_value: placeholderInitialValueSchema(),
  }),
  z.object({
    type: z.literal("toggle"),
    variable: placeholderVariableSchema(),
    name: placeholderControlNameSchema(),
    initial_value: placeholderInitialValueSchema(),
  }),
  z.object({
    type: z.literal("impulse"),
    variable: placeholderVariableSchema(),
    name: placeholderControlNameSchema(),
    duration: z.number().finite().positive().optional().describe("Seconds the impulse stays at 1 (Blockbench default 0.1)."),
  }),
]);

/**
 * Input for `variable_placeholders`: read, replace, upsert or remove lines of
 * the project's animation Variable Placeholders text.
 */
export const variablePlaceholdersParameters = z.object({
  action: z
    .enum(["get", "set", "add", "remove"])
    .describe("get: read text, parsed lines and live controls. set: replace the whole text. add: write one structured line. remove: delete every line assigning variable."),
  text: z
    .string()
    .max(100_000)
    .optional()
    .describe("Complete placeholder text for set; one `variable = expression` per line. Empty clears all placeholders."),
  entry: variablePlaceholderEntrySchema.optional().describe("Structured line for add."),
  replace_existing: z
    .boolean()
    .default(true)
    .describe("For add: replace an existing line for the same variable (aliases such as v. match) instead of appending a duplicate."),
  variable: z.string().min(1).optional().describe("Variable to delete for remove."),
});

/** Input for `list_molang_variables`: optional name filter over Blockbench's built-in variables. */
export const listMolangVariablesParameters = z.object({
  filter: z
    .string()
    .optional()
    .describe("Case-insensitive substring filter on variable names, e.g. 'camera'."),
});
