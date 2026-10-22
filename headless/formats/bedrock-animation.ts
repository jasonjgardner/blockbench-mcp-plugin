/**
 * Bedrock animation (`.animation.json`) compiler for `.bbmodel` documents,
 * ported from Blockbench's `bedrock_animation` codec.
 *
 * @module
 */

import { invertMolang } from "../document/molang";
import type { IAnimation, IBBModel, IKeyframe } from "../document/schema";

/** Compile options. */
export interface IBedrockAnimationCompileOptions {
  /** Animation names or UUIDs; defaults to all animations. */
  animations?: readonly string[];
}

type Json = Record<string, unknown>;
type TransformChannel = "rotation" | "position" | "scale";

const CHANNELS: readonly TransformChannel[] = ["rotation", "position", "scale"];
const AXES = ["x", "y", "z"] as const;

function timecode(time: number, snapping: number | undefined): string {
  const framesPerSecond = snapping === undefined ? undefined : Math.min(120, Math.max(1, snapping));
  const snapped = framesPerSecond === undefined ? time : Math.max(0, Math.round(time * framesPerSecond) / framesPerSecond);
  const rounded = Number(snapped.toFixed(4));
  return Number.isInteger(rounded) ? `${rounded}.0` : String(rounded);
}

function roundTime(time: number): number {
  return Number(time.toFixed(4));
}

function valueAt(keyframe: IKeyframe, index: number, channel: TransformChannel): [string | number, string | number, string | number] {
  const point = keyframe.data_points[index] ?? keyframe.data_points[0];
  return AXES.map((axis) => {
    const value = point?.[axis];
    return value === undefined ? (channel === "scale" ? 1 : 0) : value;
  }) as [string | number, string | number, string | number];
}

function bedrockVector(value: [string | number, string | number, string | number], channel: TransformChannel): [string | number, string | number, string | number] {
  return value.map((axis, index) => {
    const mirrored = channel === "position" ? index === 0 : channel === "rotation" && index < 2;
    return mirrored ? invertMolang(axis) : axis;
  }) as [string | number, string | number, string | number];
}

function compileKeyframe(
  keyframe: IKeyframe,
  channel: TransformChannel,
  previous: IKeyframe | undefined,
): unknown {
  const points = keyframe.data_points;
  if (keyframe.interpolation === "catmullrom") {
    const includePre = (!previous && keyframe.time > 0) || (previous !== undefined && previous.interpolation !== "catmullrom");
    return {
      ...(includePre ? { pre: bedrockVector(valueAt(keyframe, 0, channel), channel) } : {}),
      post: bedrockVector(valueAt(keyframe, includePre ? 1 : 0, channel), channel),
      lerp_mode: "catmullrom",
    };
  }
  if (points.length === 1) {
    if (previous?.interpolation === "step") {
      return {
        pre: bedrockVector(valueAt(previous, 1, channel), channel),
        post: bedrockVector(valueAt(keyframe, 0, channel), channel),
      };
    }
    return bedrockVector(valueAt(keyframe, 0, channel), channel);
  }
  return {
    pre: bedrockVector(valueAt(keyframe, 0, channel), channel),
    post: bedrockVector(valueAt(keyframe, 1, channel), channel),
  };
}

function compileAnimation(animation: IAnimation, groups: ReadonlyMap<string, string>): Json {
  const result: Json = {};
  const maxLength = Math.max(animation.length, ...Object.values(animation.animators).flatMap((animator) => animator.keyframes.map((keyframe) => keyframe.time)), 0);
  if (animation.loop === "hold") {
    result.loop = "hold_on_last_frame";
  } else if (animation.loop === "loop" || maxLength === 0) {
    result.loop = true;
  }
  if (animation.length) result.animation_length = roundTime(animation.length);

  const bones: Json = Object.create(null) as Json;
  for (const [uuid, animator] of Object.entries(animation.animators)) {
    if (animator.type !== "bone" || animator.keyframes.length === 0) continue;
    const boneName = groups.get(uuid) ?? animator.name;
    const bone: Json = {};
    for (const channel of CHANNELS) {
      const keys = animator.keyframes
        .filter((keyframe) => keyframe.channel === channel)
        .toSorted((left, right) => left.time - right.time);
      if (keys.length === 0) continue;
      const values: Json = {};
      keys.forEach((keyframe, index) => {
        values[timecode(keyframe.time, animation.snapping)] = compileKeyframe(keyframe, channel, keys[index - 1]);
      });
      bone[channel] = values;
    }
    if (Object.keys(bone).length > 0) bones[boneName] = bone;
  }
  if (Object.keys(bones).length > 0) result.bones = bones;
  return result;
}

/**
 * Compiles selected `.bbmodel` animation clips to Bedrock animation JSON.
 *
 * @throws Error when a requested animation name or UUID does not exist.
 */
export function compileBedrockAnimations(
  doc: IBBModel,
  options: IBedrockAnimationCompileOptions = {},
): { animation: Json; names: string[] } {
  const all = doc.animations ?? [];
  const requested = new Set(options.animations ?? []);
  const selected = requested.size === 0 ? all : all.filter((animation) => requested.has(animation.name) || requested.has(animation.uuid));
  const found = new Set(selected.flatMap((animation) => [animation.name, animation.uuid]));
  const missing = [...requested].filter((reference) => !found.has(reference));
  if (missing.length > 0) throw new Error(`No animation named or identified ${missing.map((name) => `"${name}"`).join(", ")}.`);

  const groupNames = new Map(doc.groups.map((group) => [group.uuid, group.name]));
  const animations: Json = Object.create(null) as Json;
  selected.forEach((animation) => {
    animations[animation.name] = compileAnimation(animation, groupNames);
  });
  return { animation: { format_version: "1.8.0", animations }, names: selected.map((animation) => animation.name) };
}
