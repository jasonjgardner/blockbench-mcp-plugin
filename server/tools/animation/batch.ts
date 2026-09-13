/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { runUndoableAnimationEdit } from "@/lib/animation-undo";
import { animationToolDocs } from "./docs";
import { batchKeyframeOperationsParameters } from "./schemas";
import { KEYFRAME_TIME_EPSILON, TRANSFORM_CHANNELS, applyKeyframeValues, findAnimationOrSelected } from "./shared";

type Input = z.infer<typeof batchKeyframeOperationsParameters>;
type Parameters = NonNullable<Input["parameters"]>;
type Mutation = () => void;

/** Bounds synchronous sampling so tiny intervals cannot hang the editor. */
const MAX_BAKED_KEYFRAMES = 10000;
const MAX_TIME = 10000;

interface ISample {
  animator: GeneralAnimator;
  channel: string;
  time: number;
  values: ArrayVector3;
  existing?: _Keyframe;
}
interface IInterpolatingAnimator extends GeneralAnimator {
  interpolate(channel: string, allowExpression: boolean): ArrayVector3 | false;
}

/** Includes collapsed/off-timeline animators when selecting all frames. */
function selectFrames(animation: _Animation, input: Input): _Keyframe[] {
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
function numericValues(frame: _Keyframe): ArrayVector3 {
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
function planTimes(frames: _Keyframe[], timeFor: (frame: _Keyframe) => number): Mutation {
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
function planValues(frames: _Keyframe[], transform: (values: ArrayVector3) => ArrayVector3): Mutation {
  const edits = frames.map(frame => ({ frame, values: transform(numericValues(frame)) }));
  if (edits.some(({ values }) => values.some(value => !Number.isFinite(value)))) throw new Error("The value operation produced non-finite coordinates.");
  return () => { edits.forEach(({ frame, values }) => applyKeyframeValues(frame, values)); };
}

function planOffset(frames: _Keyframe[], parameters: Parameters): Mutation {
  const offset = parameters.offset_values;
  if (parameters.offset_time === undefined && offset === undefined) throw new Error("Offset requires offset_time or offset_values.");
  const times = parameters.offset_time === undefined ? undefined : planTimes(frames, frame => frame.time + (parameters.offset_time ?? 0));
  const values = offset === undefined ? undefined : planValues(frames, value => [value[0] + offset[0], value[1] + offset[1], value[2] + offset[2]]);
  return () => { times?.(); values?.(); };
}

function planScale(frames: _Keyframe[], parameters: Parameters): Mutation {
  const factor = parameters.scale_factor;
  if (factor === undefined) throw new Error("Scale requires scale_factor.");
  const pivot = parameters.scale_pivot ?? 0;
  return planTimes(frames, frame => pivot + (frame.time - pivot) * factor);
}

function planMirror(frames: _Keyframe[], parameters: Parameters): Mutation {
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
function sampleTimes(selected: _Keyframe[], channelFrames: _Keyframe[], interval: number): number[] {
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

/** Samples original curves before any insertion, restoring the playhead on every exit. */
function planBake(frames: _Keyframe[], animation: _Animation, parameters: Parameters): Mutation {
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
  return () => {
    samples.forEach(({ animator, channel, time, values, existing }) => {
      const frame = existing ?? animator.addKeyframe({ channel, time, interpolation: "linear", data_points: [{}] });
      if (!frame) throw new Error("The animator could not create a baked keyframe.");
      applyKeyframeValues(frame, values);
      frame.interpolation = "linear";
    });
  };
}

const planners: Record<Input["operation"], (frames: _Keyframe[], animation: _Animation, parameters: Parameters) => Mutation> = {
  offset: (frames, _animation, parameters) => planOffset(frames, parameters),
  scale: (frames, _animation, parameters) => planScale(frames, parameters),
  reverse: frames => {
    const times = frames.map(frame => frame.time);
    const sum = Math.min(...times) + Math.max(...times);
    return planTimes(frames, frame => sum - frame.time);
  },
  mirror: (frames, _animation, parameters) => planMirror(frames, parameters),
  smooth: frames => {
    frames.forEach(numericValues);
    return () => { frames.forEach(frame => { frame.interpolation = "catmullrom"; }); };
  },
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
      const mutate = planners[input.operation](frames, animation, input.parameters ?? {});
      runUndoableAnimationEdit({ animations: [animation] }, `Batch keyframe operation: ${input.operation}`, () => {
        mutate();
        animation.setLength();
        Animator.preview();
      });
      return `Performed ${input.operation} on ${frames.length} keyframes`;
    },
  }, animationToolDocs[5].status);
}
