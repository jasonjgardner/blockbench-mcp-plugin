/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { runUndoableAnimationEdit } from "@/lib/animation-undo";
import type { IGeckolibKeyframe } from "@/lib/geckolib";
import { reverseEasing } from "@/lib/geckolib-easing";
import { animationToolDocs } from "./docs";
import { batchKeyframeOperationsParameters } from "./schemas";
import {
  KEYFRAME_TIME_EPSILON,
  TRANSFORM_CHANNELS,
  applyKeyframeValues,
  findAnimationOrSelected,
  geckolibEasedFrames,
  readGeckolibEasing,
} from "./shared";

type Input = z.infer<typeof batchKeyframeOperationsParameters>;
type Parameters = NonNullable<Input["parameters"]>;
type Mutation = () => void;

/** A staged operation and the notes its result reports. */
interface IBatchPlan {
  apply: Mutation;
  notes: string[];
}

/** GeckoLib easing fields staged for one keyframe. */
interface IEasingEdit {
  frame: IGeckolibKeyframe;
  easing: string | undefined;
  easingArgs: number[] | undefined;
}

/** Bounds synchronous sampling so tiny intervals cannot hang the editor. */
const MAX_BAKED_KEYFRAMES = 10000;
const MAX_TIME = 10000;

interface ISample {
  animator: GeneralAnimator;
  channel: string;
  time: number;
  values: ArrayVector3;
  existing?: BBKeyframe;
}
interface IInterpolatingAnimator extends GeneralAnimator {
  interpolate(channel: string, allowExpression: boolean): ArrayVector3 | false;
}

/** Includes collapsed/off-timeline animators when selecting all frames. */
function selectFrames(animation: BBAnimation, input: Input): BBKeyframe[] {
  const all = Object.values(animation.animators).flatMap(animator => animator.keyframes);
  if (input.selection === "selected") {
    if (Timeline.selected.some(frame => !all.includes(frame))) throw new Error("Selected keyframes must belong to the active animation.");
    return [...new Set(Timeline.selected)];
  }
  if (input.selection === "all") return all;
  if (input.selection === "range") {
    const range = input.range;
    if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.start > range.end) {
      throw new Error("Range selection requires finite times with 0 <= start <= end.");
    }
    return all.filter(frame => frame.time >= range.start && frame.time <= range.end);
  }
  const pattern = input.pattern;
  if (!pattern) throw new Error("Pattern selection requires an interval and optional offset.");
  return all.filter(frame => {
    const cycles = (frame.time - pattern.offset) / pattern.interval;
    return Math.abs(cycles - Math.round(cycles)) * pattern.interval < KEYFRAME_TIME_EPSILON;
  });
}

/** Rejects expressions, effects and pre/post values before numeric arithmetic. */
function numericValues(frame: BBKeyframe): ArrayVector3 {
  if (!TRANSFORM_CHANNELS.some(channel => channel === frame.channel) || frame.data_points.length !== 1) {
    throw new Error("Value edits and baking require transform keyframes with one data point; effects and pre/post keyframes are unsupported.");
  }
  const raw = frame.getArray();
  const values = raw.map(value => typeof value === "string" && !value.trim() ? Number.NaN : Number(value));
  if (values.length !== 3 || values.some(value => !Number.isFinite(value))) {
    throw new Error("Value edits and baking require finite numeric values. Use native animation tools for Molang expressions.");
  }
  return [values[0], values[1], values[2]];
}

/** Stages all times and checks channel collisions before history or mutation. */
function planTimes(frames: BBKeyframe[], timeFor: (frame: BBKeyframe) => number): Mutation {
  const edits = frames.map(frame => ({ frame, time: timeFor(frame) }));
  if (edits.some(({ time }) => !Number.isFinite(time) || time < 0 || time > MAX_TIME)) {
    throw new Error(`Resulting keyframe times must be finite and between 0 and ${MAX_TIME} seconds.`);
  }
  const timeByFrame = new Map(edits.map(({ frame, time }) => [frame, time]));
  if (edits.some(({ frame, time }) => frame.animator.keyframes.some(other =>
    other !== frame && other.channel === frame.channel && Math.abs((timeByFrame.get(other) ?? other.time) - time) < KEYFRAME_TIME_EPSILON
  ))) throw new Error("The operation would place multiple keyframes at the same time in one channel.");
  return () => { edits.forEach(({ frame, time }) => { frame.time = time; }); };
}

/** Validates all values so an unsupported frame cannot leave earlier frames changed. */
function planValues(frames: BBKeyframe[], transform: (values: ArrayVector3) => ArrayVector3): Mutation {
  const edits = frames.map(frame => ({ frame, values: transform(numericValues(frame)) }));
  if (edits.some(({ values }) => values.some(value => !Number.isFinite(value)))) throw new Error("The value operation produced non-finite coordinates.");
  return () => { edits.forEach(({ frame, values }) => applyKeyframeValues(frame, values)); };
}

function planOffset(frames: BBKeyframe[], parameters: Parameters): Mutation {
  const offset = parameters.offset_values;
  if (parameters.offset_time === undefined && offset === undefined) throw new Error("Offset requires offset_time or offset_values.");
  const times = parameters.offset_time === undefined ? undefined : planTimes(frames, frame => frame.time + (parameters.offset_time ?? 0));
  const values = offset === undefined ? undefined : planValues(frames, value => [value[0] + offset[0], value[1] + offset[1], value[2] + offset[2]]);
  return () => { times?.(); values?.(); };
}

function writeEasing({ frame, easing, easingArgs }: IEasingEdit): void {
  frame.easing = easing;
  frame.easingArgs = easingArgs;
}

/** Stages removing the GeckoLib easing of keys whose incoming segment the operation replaces. */
function planEasingRemoval(frames: readonly BBKeyframe[], reason: string): IBatchPlan {
  const edits = geckolibEasedFrames(frames).map((frame): IEasingEdit => ({ frame, easing: undefined, easingArgs: undefined }));
  return {
    apply: () => edits.forEach(writeEasing),
    notes: edits.length ? [`Cleared the GeckoLib easing of ${edits.length} keyframe(s): ${reason}.`] : [],
  };
}

/**
 * Stages GeckoLib easings for keys whose order reverses, like the GeckoLib
 * plugin's handler for Blockbench's Reverse Keyframes action. An easing shapes
 * the segment arriving at its key, so each easing flips direction (easeIn and
 * easeOut swap) and moves to the key that now ends the same segment; the
 * earliest key of each channel loses its easing.
 */
function planReversedEasings(frames: readonly BBKeyframe[], timeFor: (frame: BBKeyframe) => number): IBatchPlan {
  if (!geckolibEasedFrames(frames).length) return { apply: () => undefined, notes: [] };
  const edits = [...Map.groupBy(frames, frame => frame.animator)].flatMap(([, animatorFrames]) =>
    [...Map.groupBy(animatorFrames, frame => frame.channel)].flatMap(([, channelFrames]) => {
      const ordered: IGeckolibKeyframe[] = channelFrames.toSorted((a, b) => timeFor(a) - timeFor(b));
      return ordered.map((frame, index): IEasingEdit => {
        if (index === 0) return { frame, easing: undefined, easingArgs: undefined };
        const source = readGeckolibEasing(ordered[index - 1]);
        return { frame, easing: reverseEasing(source.easing), easingArgs: source.easingArgs };
      });
    }));
  return {
    apply: () => edits.forEach(writeEasing),
    notes: ["GeckoLib easings were reversed and moved to the key each segment now arrives at, as the GeckoLib plugin does."],
  };
}

/** The per-key part of Blockbench's Reverse Keyframes action: pre/post values and Bezier handles swap sides. */
function reverseKeyframeContent(frame: BBKeyframe): void {
  if (frame.transform && frame.data_points.length > 1) frame.data_points.reverse();
  if (frame.interpolation !== "bezier") return;
  const rightTime = [...frame.bezier_right_time];
  const rightValue = [...frame.bezier_right_value];
  [0, 1, 2].forEach(slot => {
    frame.bezier_right_time[slot] = -frame.bezier_left_time[slot];
    frame.bezier_right_value[slot] = frame.bezier_left_value[slot];
    frame.bezier_left_time[slot] = -rightTime[slot];
    frame.bezier_left_value[slot] = rightValue[slot];
  });
}

/** Reverses the order of keys like the native Reverse Keyframes action, including GeckoLib easings. */
function planReversal(frames: BBKeyframe[], timeFor: (frame: BBKeyframe) => number): IBatchPlan {
  const retime = planTimes(frames, timeFor);
  const easings = planReversedEasings(frames, timeFor);
  return {
    apply: () => {
      retime();
      frames.forEach(reverseKeyframeContent);
      easings.apply();
    },
    notes: easings.notes,
  };
}

/** A negative factor also reverses key order, so it is handled like reverse. */
function planScale(frames: BBKeyframe[], parameters: Parameters): IBatchPlan {
  const factor = parameters.scale_factor;
  if (factor === undefined) throw new Error("Scale requires scale_factor.");
  const pivot = parameters.scale_pivot ?? 0;
  const timeFor = (frame: BBKeyframe): number => pivot + (frame.time - pivot) * factor;
  return factor < 0 ? planReversal(frames, timeFor) : { apply: planTimes(frames, timeFor), notes: [] };
}

function planMirror(frames: BBKeyframe[], parameters: Parameters): Mutation {
  const axis = parameters.mirror_axis;
  if (!axis) throw new Error("Mirror requires mirror_axis.");
  const index = { x: 0, y: 1, z: 2 }[axis];
  return planValues(frames, values => {
    const mirrored: ArrayVector3 = [...values];
    mirrored[index] *= -1;
    return mirrored;
  });
}

function isInterpolatingAnimator(animator: GeneralAnimator): animator is IInterpolatingAnimator {
  return typeof animator.interpolate === "function";
}

/** Sample a selected channel span while retaining all existing keyframe times. */
function sampleTimes(selected: BBKeyframe[], channelFrames: BBKeyframe[], interval: number): number[] {
  const start = Math.min(...selected.map(frame => frame.time));
  const end = Math.max(...selected.map(frame => frame.time));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > MAX_TIME || start === end) {
    throw new Error("Baking requires at least two selected times in each channel, between 0 and 10000 seconds.");
  }
  const count = Math.ceil((end - start) / interval);
  if (!Number.isFinite(count) || count > MAX_BAKED_KEYFRAMES) throw new Error(`Bake exceeds the ${MAX_BAKED_KEYFRAMES} keyframe limit; increase bake_interval.`);
  const original = channelFrames.filter(frame => frame.time >= start && frame.time <= end).map(frame => frame.time);
  const grid = Array.from({ length: count }, (_, index) => start + index * interval)
    .map(time => original.find(existing => Math.abs(existing - time) < KEYFRAME_TIME_EPSILON) ?? time);
  return [...new Set([...grid, end, ...original])].toSorted((a, b) => a - b);
}

/** Smoothing switches keys to catmullrom, where GeckoLib reads no easing, so their easings are cleared in the same edit. */
function planSmooth(frames: BBKeyframe[]): IBatchPlan {
  frames.forEach(numericValues);
  const easings = planEasingRemoval(frames, "GeckoLib ignores easings on smooth (catmullrom) keys");
  return {
    apply: () => {
      frames.forEach(frame => { frame.interpolation = "catmullrom"; });
      easings.apply();
    },
    notes: easings.notes,
  };
}

/**
 * Samples original curves before any insertion, restoring the playhead on every exit.
 * GeckoLib easings shape the samples, so keys inside a baked span lose theirs;
 * the first key of each span keeps the easing of the segment arriving from before it.
 */
function planBake(frames: BBKeyframe[], animation: BBAnimation, parameters: Parameters): IBatchPlan {
  const interval = parameters.bake_interval ?? 1 / animation.snapping;
  if (!Number.isFinite(interval) || interval < KEYFRAME_TIME_EPSILON) throw new Error(`bake_interval must be at least ${KEYFRAME_TIME_EPSILON} seconds.`);
  const groups = [...Map.groupBy(frames, frame => frame.animator)].flatMap(([animator, selected]) =>
    [...Map.groupBy(selected, frame => frame.channel)].map(([channel, matching]) => ({ animator, channel, selected: matching }))
  );
  const plans = groups.map(({ animator, channel, selected }) => {
    if (!isInterpolatingAnimator(animator)) throw new Error("This animator does not support numeric transform interpolation.");
    const channelFrames = animator.keyframes.filter(frame => frame.channel === channel);
    channelFrames.forEach(frame => {
      numericValues(frame);
      if (frame.interpolation === "step") throw new Error("Numeric baking does not support stepped curves; use native baking to preserve discontinuities.");
    });
    return { animator, channel, channelFrames, times: sampleTimes(selected, channelFrames, interval) };
  });
  if (plans.reduce((total, plan) => total + plan.times.length, 0) > MAX_BAKED_KEYFRAMES) {
    throw new Error(`Bake exceeds the ${MAX_BAKED_KEYFRAMES} total keyframe limit; increase bake_interval or narrow the selection.`);
  }
  const originalTime = Timeline.time;
  let samples: ISample[];
  try {
    samples = plans.flatMap(({ animator, channel, channelFrames, times }) => times.map(time => {
      Timeline.time = time;
      const values = animator.interpolate(channel, false);
      if (!values || values.length !== 3 || values.some(value => !Number.isFinite(value))) throw new Error("Native interpolation did not return finite numeric values.");
      return { animator, channel, time, values: [...values] as ArrayVector3, existing: channelFrames.find(frame => Math.abs(frame.time - time) < KEYFRAME_TIME_EPSILON) };
    }));
  } finally {
    Timeline.time = originalTime;
  }
  const inside = plans.flatMap(({ channelFrames, times }) => channelFrames.filter(frame =>
    frame.time > times[0] + KEYFRAME_TIME_EPSILON && frame.time < (times.at(-1) ?? 0) + KEYFRAME_TIME_EPSILON));
  const easings = planEasingRemoval(inside, "the baked samples already follow the eased curve");
  return {
    apply: () => {
      samples.forEach(({ animator, channel, time, values, existing }) => {
        const frame = existing ?? animator.addKeyframe({ channel, time, interpolation: "linear", data_points: [{}] });
        if (!frame) throw new Error("The animator could not create a baked keyframe.");
        applyKeyframeValues(frame, values);
        frame.interpolation = "linear";
      });
      easings.apply();
    },
    notes: easings.notes,
  };
}

/** Wraps a plan that reports nothing beyond the operation itself. */
function silent(apply: Mutation): IBatchPlan {
  return { apply, notes: [] };
}

const planners: Record<Input["operation"], (frames: BBKeyframe[], animation: BBAnimation, parameters: Parameters) => IBatchPlan> = {
  offset: (frames, _animation, parameters) => silent(planOffset(frames, parameters)),
  scale: (frames, _animation, parameters) => planScale(frames, parameters),
  reverse: frames => {
    const times = frames.map(frame => frame.time);
    const sum = Math.min(...times) + Math.max(...times);
    return planReversal(frames, frame => sum - frame.time);
  },
  mirror: (frames, _animation, parameters) => silent(planMirror(frames, parameters)),
  smooth: planSmooth,
  bake: planBake,
};

/**
 * Registers atomic batch keyframe edits for the active animation. Value arithmetic
 * requires numeric transform frames. Baking samples continuous numeric curves in
 * selected channel spans, limits total samples, and restores the playhead; full
 * animation Undo captures existing and newly inserted frames together.
 */
export function registerBatchKeyframeOperationsTool(): void {
  createTool(animationToolDocs[5].name, {
    ...animationToolDocs[5],
    parameters: batchKeyframeOperationsParameters,
    async execute(input) {
      const animation = findAnimationOrSelected();
      if (!animation) throw new Error("No animation selected.");
      const frames = selectFrames(animation, input);
      if (!frames.length) throw new Error("No keyframes found matching selection criteria.");
      const plan = planners[input.operation](frames, animation, input.parameters ?? {});
      runUndoableAnimationEdit({ animations: [animation] }, `Batch keyframe operation: ${input.operation}`, () => {
        plan.apply();
        animation.setLength();
        Animator.preview();
      });
      return [`Performed ${input.operation} on ${frames.length} keyframes.`, ...plan.notes].join(" ");
    },
  }, animationToolDocs[5].status);
}
