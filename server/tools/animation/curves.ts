/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { runUndoableAnimationEdit } from "@/lib/animation-undo";
import { isGeckolibFormat } from "@/lib/geckolib";
import { findGroupOrThrow } from "@/lib/util";
import { animationToolDocs } from "./docs";
import { animationGraphEditorParameters } from "./schemas";
import { findAnimationOrSelected, geckolibEasedFrames } from "./shared";

type GraphEditorInput = z.infer<typeof animationGraphEditorParameters>;
type CurveAction = GraphEditorInput["action"];
type BezierAction = Extract<CurveAction, "ease_in" | "ease_out" | "ease_in_out" | "custom">;
type KeyWideAction = Exclude<CurveAction, BezierAction>;
type AxisLetter = "x" | "y" | "z";

/** One normalized control point: [time fraction 0..1, value fraction] of a segment. */
type ControlPoint = readonly [number, number];

/** Normalized cubic Bezier of one segment, like CSS `cubic-bezier(x1, y1, x2, y2)`. */
interface INormalizedCurve {
  /** Handle leaving the segment's first key. */
  outgoing: ControlPoint;
  /** Handle entering the segment's last key, measured from the segment start. */
  incoming: ControlPoint;
}

/** A validated curve edit, applied inside the Undo transaction, and a note for the result. */
interface ICurvePlan {
  apply: () => void;
  note: string;
}

/** Native handle arrays staged for one key; only edited axes differ from the current values. */
interface IHandlePlan {
  frame: BBKeyframe;
  left_time: ArrayVector3;
  left_value: ArrayVector3;
  right_time: ArrayVector3;
  right_value: ArrayVector3;
}

/** The CSS `ease-in`, `ease-out` and `ease-in-out` timing curves. */
const EASING_PRESETS: Record<Exclude<BezierAction, "custom">, INormalizedCurve> = {
  ease_in: { outgoing: [0.42, 0], incoming: [1, 1] },
  ease_out: { outgoing: [0, 0], incoming: [0.58, 1] },
  ease_in_out: { outgoing: [0.42, 0], incoming: [0.58, 1] },
};

/** Native interpolation written by each key-wide action. */
const KEY_WIDE_INTERPOLATION: Record<KeyWideAction, string> = {
  linear: "linear",
  stepped: "step",
  smooth: "catmullrom",
};

const AXES: readonly AxisLetter[] = ["x", "y", "z"];
const AXIS_INDEX: Record<AxisLetter, number> = { x: 0, y: 1, z: 2 };

/** Handles closer than this count as mirrored when deciding whether they can stay linked. */
const MIRROR_TOLERANCE = 1e-9;

function isBezierAction(action: CurveAction): action is BezierAction {
  return action === "ease_in" || action === "ease_out" || action === "ease_in_out" || action === "custom";
}

/** Keys of the channel inside the requested range, oldest first. */
function selectKeyframes(frames: BBKeyframe[], range: GraphEditorInput["keyframe_range"], label: string): BBKeyframe[] {
  if (range && (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.start > range.end)) {
    throw new Error("keyframe_range requires finite times with 0 <= start <= end.");
  }
  const selected = frames
    .filter(frame => !range || (frame.time >= range.start && frame.time <= range.end))
    .toSorted((a, b) => a.time - b.time);
  if (!selected.length) throw new Error(`No ${label} keyframes lie in the requested range.`);
  return selected;
}

/** Whether rotation keys of this animator are slerped, which ignores catmullrom and Bezier curves. */
function usesQuaternionRotation(animator: GeneralAnimator): boolean {
  const perAnimator = Boolean(Reflect.get(Format, "per_animator_rotation_interpolation"));
  return Boolean(perAnimator ? Reflect.get(animator, "quaternion_interpolation") : Reflect.get(Format, "quaternion_interpolation"));
}

/**
 * Refuses curves that the preview or the export would not keep.
 *
 * Native interpolation slerps quaternion rotation keys, so smooth and Bezier
 * curves never show. In GeckoLib projects, the GeckoLib plugin's `render_frame`
 * handler (`renderFrameCallback`, plugin 4.2.5) switches every step key shown
 * in the timeline back to linear on each frame (and adds a second data point to
 * the selected keys), so the step shape is lost. GeckoLib 5.5 has no Bezier
 * interpolation either: it reads no handles and loads the plugin's `"bezier"`
 * easing name as linear, so a Bezier curve reaches the game only as the linear
 * samples Blockbench bakes at the animation's snapping rate.
 */
function assertCurveApplies(action: CurveAction, channel: string, animator: GeneralAnimator): void {
  const curved = action === "smooth" || isBezierAction(action);
  if (curved && channel === "rotation" && usesQuaternionRotation(animator)) {
    throw new Error(`${action} is ignored here: this rotation channel uses quaternion interpolation, which blends keys spherically. Use linear or stepped.`);
  }
  if (!isGeckolibFormat()) return;
  if (action === "stepped") {
    throw new Error('GeckoLib models cannot keep step interpolation: on every render frame the GeckoLib plugin switches step keys shown in the timeline back to linear, so the step shape is lost. Use geckolib_set_keyframe_easing with easing "step" instead.');
  }
  if (isBezierAction(action)) {
    throw new Error(`GeckoLib has no Bezier interpolation: GeckoLib 5.5 reads no handles and loads the exported "bezier" easing as linear, so the curve would only reach the game as linear samples. Use geckolib_set_keyframe_easing (for example easeInSine or easeInOutCubic) or smooth instead of ${action}.`);
  }
}

/**
 * Plans a key-wide interpolation change, which Blockbench stores once per key
 * for every axis. GeckoLib reads no easing on smooth (catmullrom) keys, so
 * smoothing clears their easings in the same edit instead of leaving the
 * plugin to drop them silently on the next frame.
 */
function planInterpolation(frames: BBKeyframe[], axis: GraphEditorInput["axis"], action: KeyWideAction): ICurvePlan {
  if (axis !== "all") {
    throw new Error(`${action} changes the key-wide interpolation, which covers every axis; use axis "all".`);
  }
  const interpolation = KEY_WIDE_INTERPOLATION[action];
  const eased = action === "smooth" ? geckolibEasedFrames(frames) : [];
  return {
    apply: () => {
      frames.forEach(frame => {
        frame.interpolation = interpolation;
      });
      eased.forEach(frame => {
        frame.easing = undefined;
        frame.easingArgs = undefined;
      });
    },
    note: eased.length ? ` Cleared the GeckoLib easing of ${eased.length} keyframe(s): GeckoLib ignores easings on smooth (catmullrom) keys.` : "",
  };
}

/** Resolves the normalized curve for an easing preset or a validated custom curve. */
function resolveCurve(action: BezierAction, custom: GraphEditorInput["custom_curve"]): INormalizedCurve {
  if (action !== "custom") return EASING_PRESETS[action];
  if (!custom) throw new Error("custom_curve is required for the custom action.");
  const points = [custom.control_point_1, custom.control_point_2];
  if (points.some(([time]) => time < 0 || time > 1)) {
    throw new Error("custom_curve time fractions must be between 0 and 1.");
  }
  return {
    outgoing: [custom.control_point_1[0], custom.control_point_1[1]],
    incoming: [custom.control_point_2[0], custom.control_point_2[1]],
  };
}

/** Numeric value of one axis of a single-data-point key, or an error naming the key. */
function numericAxisValue(frame: BBKeyframe, axis: AxisLetter): number {
  const raw = frame.get(axis);
  const value = typeof raw === "string" && !raw.trim() ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`The key at ${frame.time}s has a non-numeric ${axis} value; Bezier easing needs numeric values. Resolve Molang expressions first.`);
  }
  return value;
}

/** Validates the keys a Bezier edit reads before any handle is staged. */
function assertBezierKeys(frames: BBKeyframe[], axis: GraphEditorInput["axis"]): void {
  if (frames.length < 2) throw new Error("Easing and custom curves need at least two keyframes in the selected range.");
  if (frames.some(frame => frame.data_points.length !== 1)) {
    throw new Error("Easing and custom curves need keys with one data point; keys with separate pre/post values are unsupported.");
  }
  if (frames.some((frame, index) => index > 0 && frame.time <= frames[index - 1].time)) {
    throw new Error("Easing and custom curves need keys at distinct times.");
  }
  if (axis !== "all" && frames.some(frame => frame.interpolation !== "bezier")) {
    throw new Error(`A ${axis}-axis curve needs keys that already use Bezier interpolation, because interpolation is key-wide and switching it would change the other axes. Apply the curve with axis "all" first.`);
  }
}

/**
 * Stages native per-axis handles for every segment between consecutive keys.
 *
 * Blockbench draws a segment from the first key's right handle to the last
 * key's left handle; times are offsets from the key and values offsets from its
 * value. A normalized point [x, y] of a segment lasting `gap` seconds and
 * changing by `delta` becomes a right handle of (x·gap, y·delta) and a left
 * handle of ((x − 1)·gap, (y − 1)·delta).
 */
function planHandles(frames: BBKeyframe[], axes: readonly AxisLetter[], curve: INormalizedCurve): IHandlePlan[] {
  const plans = frames.map((frame): IHandlePlan => ({
    frame,
    left_time: [...frame.bezier_left_time],
    left_value: [...frame.bezier_left_value],
    right_time: [...frame.bezier_right_time],
    right_value: [...frame.bezier_right_value],
  }));
  plans.slice(0, -1).forEach((start, index) => {
    const end = plans[index + 1];
    const gap = end.frame.time - start.frame.time;
    axes.forEach(axis => {
      const slot = AXIS_INDEX[axis];
      const delta = numericAxisValue(end.frame, axis) - numericAxisValue(start.frame, axis);
      start.right_time[slot] = curve.outgoing[0] * gap;
      start.right_value[slot] = curve.outgoing[1] * delta;
      end.left_time[slot] = (curve.incoming[0] - 1) * gap;
      end.left_value[slot] = (curve.incoming[1] - 1) * delta;
    });
  });
  const values = plans.flatMap(plan => [...plan.left_time, ...plan.left_value, ...plan.right_time, ...plan.right_value]);
  if (values.some(value => !Number.isFinite(value))) throw new Error("The curve produced non-finite handles.");
  return plans;
}

/** Whether a key's handles mirror each other, which `bezier_linked` keys must keep when edited natively. */
function handlesMirror(plan: IHandlePlan): boolean {
  return [0, 1, 2].every(slot =>
    Math.abs(plan.right_time[slot] + plan.left_time[slot]) < MIRROR_TOLERANCE
    && Math.abs(plan.right_value[slot] + plan.left_value[slot]) < MIRROR_TOLERANCE);
}

/** Plans a Bezier easing on the requested axes, preserving the other axes' handles. */
function planBezier(frames: BBKeyframe[], input: GraphEditorInput, action: BezierAction): ICurvePlan {
  const curve = resolveCurve(action, input.custom_curve);
  assertBezierKeys(frames, input.axis);
  const plans = planHandles(frames, input.axis === "all" ? AXES : [input.axis], curve);
  return {
    apply: () => plans.forEach(plan => {
      const { frame } = plan;
      frame.interpolation = "bezier";
      [0, 1, 2].forEach(slot => {
        frame.bezier_left_time[slot] = plan.left_time[slot];
        frame.bezier_left_value[slot] = plan.left_value[slot];
        frame.bezier_right_time[slot] = plan.right_time[slot];
        frame.bezier_right_value[slot] = plan.right_value[slot];
      });
      // Linked handles are mirrored by the graph editor on the next drag, which would undo this curve.
      if (!handlesMirror(plan)) frame.bezier_linked = false;
    }),
    note: "",
  };
}

/**
 * Registers `animation_graph_editor`, which sets the interpolation of one bone
 * channel's keys or eases the segments between them with Bezier handles, per
 * axis. Every check runs before the single reversible edit. Call only after
 * Blockbench globals exist.
 */
export function registerAnimationGraphEditorTool(): void {
  createTool(
    animationToolDocs[2].name,
    {
      ...animationToolDocs[2],
      parameters: animationGraphEditorParameters,
      async execute(input) {
        const { animation_id, bone_name, channel, axis, action, keyframe_range } = input;
        const animation = findAnimationOrSelected(animation_id);
        if (!animation) throw new Error("No animation found or selected.");
        const group = findGroupOrThrow(bone_name);
        const animator = animation.animators[group.uuid];
        const channelFrames: BBKeyframe[] = animator?.[channel] ?? [];
        if (!animator || !channelFrames.length) throw new Error(`No keyframes found for ${bone_name}.${channel}.`);
        const frames = selectKeyframes(channelFrames, keyframe_range, `${bone_name}.${channel}`);
        assertCurveApplies(action, channel, animator);
        const plan = isBezierAction(action) ? planBezier(frames, input, action) : planInterpolation(frames, axis, action);

        runUndoableAnimationEdit({ animations: [animation] }, `Graph editor: ${action}`, () => {
          plan.apply();
          Animator.preview();
        });
        updateKeyframeSelection();

        const axes = axis === "all" ? AXES.join(", ") : axis;
        const summary = isBezierAction(action)
          ? `Applied ${action} to ${frames.length - 1} segment(s) between ${frames.length} keyframes of ${bone_name}.${channel} (axes: ${axes}).`
          : `Set ${KEY_WIDE_INTERPOLATION[action]} interpolation on ${frames.length} keyframes of ${bone_name}.${channel}.`;
        return `${summary}${plan.note}`;
      },
    },
    animationToolDocs[2].status
  );
}
