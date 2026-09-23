/**
 * Samples bone animations into poses without Blockbench.
 *
 * Mirrors `BoneAnimator.interpolate` and `Keyframe.getLerp` closely enough for
 * geometric checks: step, linear and Catmull-Rom interpolation, with a
 * keyframe's last data point used when leaving it and the next keyframe's first
 * data point used when arriving (Blockbench's pre/post split). In the 5.0
 * convention the sampled values are added straight to the bone's rest
 * transform: rotation in degrees, position in units, scale as a multiplier.
 *
 * Two parts are approximations and are reported as such:
 *
 * - Bezier keyframes are sampled linearly (handles are ignored).
 * - Molang expressions are only evaluated when they are plain numbers; a channel
 *   with any other expression is skipped.
 *
 * @module
 */

import type { DataPoint, IAnimation, IKeyframe, Vec3 } from "../document/schema";
import type { IBonePose, Pose } from "./bounds";

/** Animated transform channels. */
export type Channel = "rotation" | "position" | "scale";

/** Channels sampled for posing. */
export const CHANNELS: readonly Channel[] = ["rotation", "position", "scale"];

const DEFAULTS: Readonly<Record<Channel, Vec3>> = { rotation: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1] };

/** What could not be sampled exactly. */
export interface ISamplingNotes {
  /** `animation / bone / channel` labels skipped because a value is not a plain number. */
  skippedChannels: string[];
  /** Labels of channels containing bezier keyframes, sampled linearly. */
  approximatedBezier: string[];
  /** Clips too long for the requested rate; they were sampled at {@link MAX_SAMPLES_PER_CLIP} evenly spaced times. */
  cappedClips: string[];
}

/** Upper bound on samples per clip, so a very long clip cannot stall the server. */
export const MAX_SAMPLES_PER_CLIP = 2000;

/** Fresh, empty sampling notes. */
export function emptySamplingNotes(): ISamplingNotes {
  return { skippedChannels: [], approximatedBezier: [], cappedClips: [] };
}

/** Parses one axis value; plain numbers and numeric strings only. */
export function numericValue(value: string | number | undefined, fallback: number): number | undefined {
  if (value === undefined || value === "") return fallback;
  if (typeof value === "number") return value;
  const parsed = Number(value.trim().replace(/f$/, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Converts a data point to a vector, or `undefined` if any axis is an expression. */
export function dataPointVector(point: DataPoint | undefined, fallback: Vec3): Vec3 | undefined {
  const values = (["x", "y", "z"] as const).map((axis, i) => numericValue(point?.[axis], fallback[i] ?? 0));
  const [x, y, z] = values;
  if (x === undefined || y === undefined || z === undefined) return undefined;
  return [x, y, z];
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Uniform Catmull-Rom between `p1` and `p2`. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

interface IResolvedKey {
  time: number;
  interpolation: string;
  pre: Vec3;
  post: Vec3;
}

/**
 * Samples one channel's keyframes at `time`.
 *
 * @param keys - Keyframes of a single channel, any order.
 * @returns The channel value, or `undefined` when a keyframe value is not a plain number.
 */
export function sampleChannel(keys: readonly IKeyframe[], channel: Channel, time: number): Vec3 | undefined {
  const fallback = DEFAULTS[channel];
  const resolved = keys
    .toSorted((a, b) => a.time - b.time)
    .map((key): IResolvedKey | undefined => {
      const pre = dataPointVector(key.data_points[0], fallback);
      const post = dataPointVector(key.data_points.at(-1), fallback);
      return pre && post ? { time: key.time, interpolation: key.interpolation, pre, post } : undefined;
    });
  if (resolved.some((key) => key === undefined)) return undefined;
  const sorted = resolved as IResolvedKey[];
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return fallback;
  if (time <= first.time) return first.pre;
  // At a keyframe's exact time Blockbench shows its first data point (the "pre" value).
  const exact = sorted.find((key) => Math.abs(key.time - time) < 1e-9);
  if (exact) return exact.pre;
  if (time >= last.time) return last.post;
  const nextIndex = sorted.findIndex((key) => key.time > time);
  const before = sorted[nextIndex - 1];
  const after = sorted[nextIndex];
  if (!before || !after) return last.post;
  if (before.interpolation === "step") return before.post;
  const t = (time - before.time) / (after.time - before.time);
  const useCatmull = before.interpolation === "catmullrom" || after.interpolation === "catmullrom";
  if (!useCatmull) return [0, 1, 2].map((axis) => lerp(before.post[axis] ?? 0, after.pre[axis] ?? 0, t)) as unknown as Vec3;
  const p0 = sorted[nextIndex - 2]?.post ?? before.post;
  const p3 = sorted[nextIndex + 1]?.pre ?? after.pre;
  return [0, 1, 2].map((axis) => catmullRom(p0[axis] ?? 0, before.post[axis] ?? 0, after.pre[axis] ?? 0, p3[axis] ?? 0, t)) as unknown as Vec3;
}

/**
 * Samples every bone animator of a clip at `time`.
 *
 * @param notes - Collects channels that were skipped or approximated.
 * @returns Pose offsets keyed by bone (group) UUID.
 */
export function samplePose(animation: IAnimation, time: number, notes?: ISamplingNotes): Pose {
  const entries = Object.entries(animation.animators).flatMap(([boneId, animator]): [string, IBonePose][] => {
    if (animator.type !== "bone") return [];
    const channels = CHANNELS.map((channel) => {
      const keys = animator.keyframes.filter((key) => key.channel === channel);
      const label = `${animation.name} / ${animator.name || boneId} / ${channel}`;
      if (keys.some((key) => key.interpolation === "bezier") && notes && !notes.approximatedBezier.includes(label)) notes.approximatedBezier.push(label);
      const value = sampleChannel(keys, channel, time);
      if (value === undefined && notes && !notes.skippedChannels.includes(label)) notes.skippedChannels.push(label);
      return value ?? DEFAULTS[channel];
    });
    const [rotation = DEFAULTS.rotation, position = DEFAULTS.position, scale = DEFAULTS.scale] = channels;
    return [[boneId, { rotation, position, scale }]];
  });
  return new Map(entries);
}

/**
 * Evenly spaced sample times covering a clip, including both ends.
 *
 * @param rate - Samples per second.
 * @param maxSamples - Cap on the number of intervals; see {@link MAX_SAMPLES_PER_CLIP}.
 */
export function sampleTimes(length: number, rate: number, maxSamples = MAX_SAMPLES_PER_CLIP): number[] {
  const count = Math.min(maxSamples, Math.max(1, Math.ceil(length * rate)));
  return Array.from({ length: count + 1 }, (_, i) => (length * i) / count);
}
