/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { findGroupOrThrow } from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { createGroupWithUndo } from "@/lib/group-creation";
import {
  vector3Schema,
  animationIdOptionalSchema,
  animationChannelEnum,
  interpolationEnum,
  axisEnum,
  axisWithAllEnum,
  timeRangeSchema,
  boneNameSchema,
  loopModeEnum,
  keyframeDataSchema,
} from "@/lib/zodObjects";

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
    .max(10000)
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
    .max(10000)
    .optional()
    .describe("Animation length in seconds, including all keyframes (for set_length action)."),
  fps: z
    .number()
    .int()
    .min(10)
    .max(120)
    .optional()
    .describe("Integer frames per second, 10–120 (for set_fps action; Blockbench minimum is 10)."),
  loop_mode: loopModeEnum.optional().describe("Loop mode for the animation."),
  range: timeRangeSchema.optional().describe("Time range for selection."),
});

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

export const animationToolDocs: ToolSpec[] = [
  {
    name: "create_animation",
    description: "Creates and selects an undoable animation with linear keyframes for existing bones, using Blockbench editor coordinates. Returns its UUID and actual name.",
    annotations: {
      title: "Create Animation",
      destructiveHint: true,
    },
    parameters: createAnimationParameters,
    status: STATUS_STABLE,
  },
  {
    name: "manage_keyframes",
    description:
      "Creates, deletes, or edits keyframes in the animation timeline for specific bones and channels.",
    annotations: {
      title: "Manage Keyframes",
      destructiveHint: true,
    },
    parameters: manageKeyframesParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "animation_graph_editor",
    description:
      "Controls animation curves in the graph editor for fine-tuning animations.",
    annotations: {
      title: "Animation Graph Editor",
      destructiveHint: true,
    },
    parameters: animationGraphEditorParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "bone_rigging",
    description:
      "Creates and manipulates the bone structure (rig) of a model for animation.",
    annotations: {
      title: "Bone Rigging",
      destructiveHint: true,
    },
    parameters: boneRiggingParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "animation_timeline",
    description:
      "Controls the animation timeline, including playback, time scrubbing, and timeline settings.",
    annotations: {
      title: "Animation Timeline",
      destructiveHint: true,
    },
    parameters: animationTimelineParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "batch_keyframe_operations",
    description: "Performs batch operations on multiple keyframes at once.",
    annotations: {
      title: "Batch Keyframe Operations",
      destructiveHint: true,
    },
    parameters: batchKeyframeOperationsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "animation_copy_paste",
    description:
      "Copies and pastes animation data between bones or animations.",
    annotations: {
      title: "Animation Copy/Paste",
      destructiveHint: true,
    },
    parameters: animationCopyPasteParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

/**
 * Applies a keyframe's data-point values through Blockbench's real per-axis
 * `Keyframe.set()` API. A bare number (uniform scale) is expanded to all three
 * axes; a `[x, y, z]` array is written component-wise.
 *
 * `Keyframe.extend()` only merges registered properties, so a `values` key is
 * silently dropped and `set("values", …)` writes a stray, unread property —
 * which is why `manage_keyframes` used to leave every data point at its channel
 * default. Scale keyframes also default to `uniform: true`, where `set()`
 * mirrors one value to all axes, so the flag is cleared before writing
 * genuinely non-uniform components; otherwise x/y/z collapse to the last write.
 *
 * @param keyframe - The keyframe to write to.
 * @param values - `[x, y, z]` for position/rotation, or a number for uniform scale.
 */
function applyKeyframeValues(
  keyframe: _Keyframe,
  values: number[] | number
): void {
  const vals = Array.isArray(values) ? values : [values, values, values];
  if (keyframe.uniform && new Set(vals).size > 1) {
    keyframe.uniform = false;
  }
  keyframe.set("x", vals[0]);
  keyframe.set("y", vals[1]);
  keyframe.set("z", vals[2]);
}

/** Registers animation editing and playback tools after Blockbench is initialized. */
export function registerAnimationTools() {
createTool(
  animationToolDocs[0].name,
  {
    ...animationToolDocs[0],
    parameters: createAnimationParameters,
    async execute({ name, loop, animation_length, bones, particle_effects }) {
      if (!Project || !Format.animation_mode) {
        throw new Error("The current project format does not support animations. Use get_capabilities to inspect supported formats.");
      }
      const targets = Object.entries(bones).map(([boneName, keyframes]) => {
        const group = findGroupOrThrow(boneName);
        const times = new Set<string>();
        keyframes.forEach((frame) => {
          (["position", "rotation", "scale"] as const).forEach((channel) => {
            if (frame[channel] === undefined) return;
            const key = `${channel}:${frame.time}`;
            if (times.has(key)) throw new Error(`Duplicate ${channel} keyframe at ${frame.time} seconds for "${boneName}".`);
            times.add(key);
          });
        });
        return { group, keyframes };
      });
      const particles = Object.entries(particle_effects ?? {}).map(([timestamp, effect]) => {
        const time = Number(timestamp);
        if (!timestamp.trim() || !Number.isFinite(time) || time < 0) {
          throw new Error(`Invalid particle timestamp "${timestamp}"; use nonnegative seconds.`);
        }
        return { time, effect };
      });
      const latestTime = Math.max(0, ...targets.flatMap(({ keyframes }) => keyframes.map(({ time }) => time)), ...particles.map(({ time }) => time));
      if (animation_length !== undefined && animation_length < latestTime) {
        throw new Error(`animation_length must include the last keyframe at ${latestTime} seconds.`);
      }

      const animations: _Animation[] = [];
      Undo.initEdit({ animations });
      try {
        const AnimationClass = Animation as unknown as typeof _Animation;
        const animation = new AnimationClass({
          name: `animation.${name}`, loop: loop ? "loop" : "once",
          length: animation_length ?? latestTime,
        });
        animations.push(animation);
        animation.add(false);
        targets.forEach(({ group, keyframes }) => {
          const animator = animation.getBoneAnimator(group);
          keyframes.forEach((data) => {
            (["position", "rotation", "scale"] as const).forEach((channel) => {
              const values = data[channel];
              if (values === undefined) return;
              const keyframe = animator.addKeyframe({
                time: data.time, channel, interpolation: "linear", data_points: [{}],
              });
              applyKeyframeValues(keyframe, values);
            });
          });
        });
        if (particles.length) {
          const effects = new EffectAnimator(animation);
          animation.animators.effects = effects;
          particles.forEach(({ time, effect }) => effects.addKeyframe({
            time, channel: "particle", data_points: [{ effect }],
          }));
        }
        animation.select();
        Animator.preview();
        Undo.finishEdit("Create animation");
        return JSON.stringify({ uuid: animation.uuid, name: animation.name, length: animation.length, loop: animation.loop, bones: targets.length });
      } catch (error) {
        (Undo.cancelEdit as (revert?: boolean) => void)(true);
        throw error;
      }
    },
  },
  animationToolDocs[0].status
);

createTool(
  animationToolDocs[1].name,
  {
    ...animationToolDocs[1],
    parameters: manageKeyframesParameters,
    async execute({ animation_id, action, bone_name, channel, keyframes }) {
      const AnimationClass = Animation as unknown as typeof _Animation;
      const animation = animation_id
        ? AnimationClass.all.find((item) => item.uuid === animation_id || item.name === animation_id)
        : AnimationClass.selected;
      if (!animation) throw new Error("No animation found or selected.");
      const group = findGroupOrThrow(bone_name);
      if (!keyframes.length || keyframes.some(({ time }) => !Number.isFinite(time) || time < 0)) {
        throw new Error("Provide at least one keyframe with a finite, nonnegative time.");
      }
      if (new Set(keyframes.map(({ time }) => time)).size !== keyframes.length) {
        throw new Error("Duplicate requested keyframe times are not supported; provide each timestamp once.");
      }
      const existingAnimator = animation.animators[group.uuid];
      const existingFrames: _Keyframe[] = existingAnimator?.[channel] ?? [];
      const matches = keyframes.map((data) => existingFrames.find((frame) => Math.abs(frame.time - data.time) < 0.001));
      if (action !== "create" && matches.some((frame) => !frame)) {
        throw new Error("No keyframe exists at one or more requested times; no keyframes changed.");
      }
      if (action === "select") {
        Undo.initSelection({ timeline: true });
        animation.select();
        Timeline.selected.forEach((frame) => { frame.selected = false; });
        Timeline.selected.splice(0);
        matches.forEach((frame) => frame?.select({ ctrlOrCmd: true }));
        updateKeyframeSelection();
        Undo.finishSelection("Select keyframes");
        return `Selected ${matches.length} keyframes for ${bone_name}.${channel}`;
      }

      Undo.initEdit({ animations: [animation] });
      try {
        const animator = animation.getBoneAnimator(group);
        keyframes.forEach((data, index) => {
          const existing = matches[index];
          if (action === "delete") {
            existing?.remove();
            return;
          }
          if (action === "create") existing?.remove();
          const frame = action === "create"
            ? animator.addKeyframe({ time: data.time, channel, interpolation: data.interpolation, data_points: [{}] })
            : existing;
          if (!frame) throw new Error("Could not resolve the target keyframe.");
          if (data.values !== undefined) applyKeyframeValues(frame, data.values);
          if (data.interpolation) frame.interpolation = data.interpolation;
          if (data.interpolation === "bezier" && data.bezier_handles) {
            const vector = (value: number | number[]): [number, number, number] =>
              Array.isArray(value) ? [value[0], value[1], value[2]] : [value, value, value];
            const handles = data.bezier_handles;
            if (handles.left_time !== undefined) frame.bezier_left_time = vector(handles.left_time);
            if (handles.right_time !== undefined) frame.bezier_right_time = vector(handles.right_time);
            if (handles.left_value !== undefined) frame.bezier_left_value = vector(handles.left_value);
            if (handles.right_value !== undefined) frame.bezier_right_value = vector(handles.right_value);
          }
        });
        animation.setLength();
        Animator.preview();
        Undo.finishEdit(`${action} keyframes`);
        return `Successfully performed ${action} on ${keyframes.length} keyframes for ${bone_name}.${channel}`;
      } catch (error) {
        (Undo.cancelEdit as (revert?: boolean) => void)(true);
        throw error;
      }
    },
  },
  animationToolDocs[1].status
);

createTool(
  animationToolDocs[2].name,
  {
    ...animationToolDocs[2],
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

      const group = findGroupOrThrow(bone_name);

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
  animationToolDocs[2].status
);

createTool(
  animationToolDocs[3].name,
  {
    ...animationToolDocs[3],
    async execute({ action, bone_data }) {
      if (action === "create") {
        const group = createGroupWithUndo({
          name: bone_data.name,
          origin: bone_data.origin ?? [0, 0, 0],
          rotation: bone_data.rotation ?? [0, 0, 0],
        }, bone_data.parent, bone_data.children, (created) => {
          if (bone_data.ik_enabled && bone_data.ik_target) {
            Object.assign(created, { ik_enabled: true, ik_target: bone_data.ik_target });
          }
        }, "Bone rigging: create");
        return `Created bone "${group.name}" with UUID ${group.uuid}`;
      }

      Undo.initEdit({
        outliner: true,
        elements: [],
        groups: [],
      });

      let result = "";

      switch (action) {
        case "parent": {
          const child = findGroupOrThrow(bone_data.name);
          const parent = bone_data.parent
            ? Group.all.find((g) => g.name === bone_data.parent)
            : "root";

          child.addTo(parent);
          result = `Parented "${bone_data.name}" to "${
            bone_data.parent || "root"
          }"`;
          break;
        }

        case "unparent": {
          const bone = findGroupOrThrow(bone_data.name);

          bone.addTo("root");
          result = `Unparented "${bone_data.name}"`;
          break;
        }

        case "delete": {
          const bone = findGroupOrThrow(bone_data.name);

          bone.remove();
          result = `Deleted bone "${bone_data.name}"`;
          break;
        }

        case "rename": {
          const bone = findGroupOrThrow(bone_data.name);

          const newName = bone_data.children?.[0] || "new_name";
          bone.name = newName;
          result = `Renamed bone to "${newName}"`;
          break;
        }

        case "set_pivot": {
          const bone = findGroupOrThrow(bone_data.name);

          if (bone_data.origin) {
            bone.origin = bone_data.origin;
          }
          result = `Set pivot point for "${bone_data.name}"`;
          break;
        }

        case "set_ik": {
          const bone = findGroupOrThrow(bone_data.name);

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
          const bone = findGroupOrThrow(bone_data.name);

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
  animationToolDocs[3].status
);

createTool(
  animationToolDocs[4].name,
  {
    ...animationToolDocs[4],
    parameters: animationTimelineParameters,
    async execute({ animation_id, action, time, length, fps, loop_mode, range }) {
      const AnimationClass = Animation as unknown as typeof _Animation;
      const animation = animation_id
        ? AnimationClass.all.find((item) => item.uuid === animation_id || item.name === animation_id)
        : AnimationClass.selected;
      if (!animation) throw new Error("No animation found or selected.");
      if (action === "set_time" && time === undefined) throw new Error("Time parameter required for set_time action.");
      if (action === "set_length" && length === undefined) throw new Error("Length parameter required for set_length action.");
      if (action === "set_fps" && fps === undefined) throw new Error("FPS parameter required for set_fps action.");
      if (action === "loop" && loop_mode === undefined) throw new Error("loop_mode parameter required for loop action.");
      if (action === "select_range" && (!range || range.start > range.end)) throw new Error("An ordered range is required for select_range action.");
      const allFrames = Object.values(animation.animators).flatMap((animator) => animator.keyframes as _Keyframe[]);
      const lastTime = Math.max(0, ...allFrames.map((frame) => frame.time));
      if (action === "set_length" && length !== undefined && length < lastTime) {
        throw new Error(`Length must include the last keyframe at ${lastTime} seconds.`);
      }
      if (action === "set_length" || action === "set_fps" || action === "loop") {
        Undo.initEdit({ animations: [animation] });
        try {
          if (action === "set_length") animation.setLength(length);
          if (action === "set_fps" && fps !== undefined) animation.snapping = fps;
          if (action === "loop" && loop_mode) animation.setLoop(loop_mode, false);
          Animator.preview();
          Undo.finishEdit(`Animation timeline: ${action}`);
          return `Updated animation ${animation.name}: ${action}`;
        } catch (error) {
          (Undo.cancelEdit as (revert?: boolean) => void)(true);
          throw error;
        }
      }
      if (action === "select_range" && range) {
        Undo.initSelection({ timeline: true });
        animation.select();
        Timeline.selected.forEach((frame) => { frame.selected = false; });
        Timeline.selected.splice(0);
        const selected = allFrames.filter((frame) => frame.time >= range.start && frame.time <= range.end);
        selected.forEach((frame) => frame.select({ ctrlOrCmd: true }));
        updateKeyframeSelection();
        Undo.finishSelection("Select animation range");
        return `Selected ${selected.length} keyframes between ${range.start} and ${range.end} seconds`;
      }
      animation.select();
      if (action === "play" || action === "set_time") {
        Modes.options.animate.select();
      }
      if (action === "play") Timeline.start();
      if (action === "pause" || action === "stop") Timeline.pause();
      if (action === "stop") Timeline.setTime(0);
      if (action === "set_time" && time !== undefined) Timeline.setTime(time);
      Animator.preview();
      return `Animation timeline: ${action}`;

    },
  },
  animationToolDocs[4].status
);

createTool(
  animationToolDocs[5].name,
  {
    ...animationToolDocs[5],
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
  animationToolDocs[5].status
);

createTool(
  animationToolDocs[6].name,
  {
    ...animationToolDocs[6],
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

          const srcBone = findGroupOrThrow(source.bone);

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

          const tgtBone = findGroupOrThrow(target.bone);

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
  animationToolDocs[6].status
);
}
