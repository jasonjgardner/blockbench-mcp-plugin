/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { findGroupOrThrow } from "@/lib/util";
import { runUndoableAnimationEdit } from "@/lib/animation-undo";
import { animationToolDocs } from "./docs";
import { animationCopyPasteParameters } from "./schemas";
import { KEYFRAME_TIME_EPSILON, findAnimationOrSelected } from "./shared";

type Input = z.infer<typeof animationCopyPasteParameters>;
type MirrorAxis = "x" | "y" | "z";
interface IClipboard {
  bone: string;
  frames: KeyframeOptions[];
}
interface IPasteEntry {
  data: KeyframeOptions;
  existing: _Keyframe[];
}

/** Plugin-local detached data; never stores live frame, animator, or mutable handle references. */
let clipboard: IClipboard | undefined;

/** Snapshot native datapoints and interpolation metadata so expressions and pre/post values survive copying. */
function copyFrame(frame: _Keyframe): KeyframeOptions {
  return {
    time: frame.time,
    channel: frame.channel,
    interpolation: frame.interpolation,
    uniform: frame.uniform,
    color: frame.color,
    data_points: frame.data_points.map(point => structuredClone(point.getUndoCopy())),
    bezier_linked: frame.bezier_linked,
    bezier_left_time: [...frame.bezier_left_time],
    bezier_left_value: [...frame.bezier_left_value],
    bezier_right_time: [...frame.bezier_right_time],
    bezier_right_value: [...frame.bezier_right_value],
  };
}

/** Copy does not create animators, modify selection or open a model-history entry. */
function copySource(source: Input["source"]): string {
  if (!source) throw new Error("Source data required for copy operation.");
  const animation = findAnimationOrSelected(source.animation);
  if (!animation) throw new Error("Source animation not found.");
  const bone = findGroupOrThrow(source.bone);
  const animator = animation.animators[bone.uuid];
  if (!animator) throw new Error(`No animation data for bone "${source.bone}".`);
  const range = source.time_range;
  if (range && (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.start > range.end)) {
    throw new Error("Copy range requires finite times with 0 <= start <= end.");
  }
  const frames = animator.keyframes.filter(frame => source.channels.some(channel => channel === frame.channel)
    && (!range || frame.time >= range.start && frame.time <= range.end));
  if (!frames.length) throw new Error("No keyframes match the requested channels and time range.");
  const copied = frames.map(copyFrame);
  clipboard = { bone: source.bone, frames: copied };
  return `Copied ${copied.length} keyframes from "${source.bone}"`;
}

/** Prepare exact timestamps and replacement frames before creating a target animator or opening Undo. */
function preparePaste(animation: _Animation, bone: Group, offset: number): IPasteEntry[] {
  if (!clipboard) throw new Error("No animation data in clipboard. Copy first.");
  const data = clipboard.frames.map(frame => ({ ...structuredClone(frame), time: frame.time + offset }));
  if (data.some(frame => !Number.isFinite(frame.time) || frame.time < 0 || frame.time > 10000)) {
    throw new Error("Pasted keyframe times must be finite and between 0 and 10000 seconds.");
  }
  if (data.some((frame, index) => data.slice(index + 1).some(other =>
    other.channel === frame.channel && Math.abs(other.time - frame.time) < KEYFRAME_TIME_EPSILON
  ))) throw new Error("Copied data contains overlapping timestamps in the same channel.");
  const existing = animation.animators[bone.uuid]?.keyframes ?? [];
  return data.map(frame => ({
    data: frame,
    existing: existing.filter(other => other.channel === frame.channel && Math.abs(other.time - frame.time) < KEYFRAME_TIME_EPSILON),
  }));
}

/** Native flip uses a numeric axis, including complementary rotation axes and matching bezier values. */
function mirrorFrame(frame: _Keyframe, axis: MirrorAxis): void {
  const index = { x: 0, y: 1, z: 2 }[axis];
  // Published types say an axis letter, but Blockbench Keyframe.flip consumes 0/1/2.
  (frame.flip as unknown as (axisIndex: number) => _Keyframe).call(frame, index);
}

/** Paste native datapoints as exact unsnapped keys, replacing collisions in one reversible edit. */
function pasteTarget(target: Input["target"], mirrored: boolean): string {
  if (!target) throw new Error("Target data required for paste operation.");
  if (!clipboard) throw new Error("No animation data in clipboard. Copy first.");
  const animation = findAnimationOrSelected(target.animation);
  if (!animation) throw new Error("Target animation not found.");
  const bone = findGroupOrThrow(target.bone);
  const entries = preparePaste(animation, bone, target.time_offset);
  const axis = target.mirror_axis ?? "x";
  runUndoableAnimationEdit({ animations: [animation] }, `${mirrored ? "Mirror paste" : "Paste"} animation data`, () => {
    const animator = animation.getBoneAnimator(bone);
    entries.forEach(({ data, existing }) => {
      existing.forEach(frame => frame.remove());
      const frame = animator.addKeyframe(data);
      if (!frame) throw new Error("The target animator could not create a pasted keyframe.");
      if (mirrored) mirrorFrame(frame, axis);
    });
    animation.setLength();
    Animator.preview();
  });
  return `Pasted ${entries.length} keyframes to "${target.bone}"${mirrored ? ` (mirrored on ${axis} axis)` : ""}`;
}

/**
 * Registers a plugin-local animation clipboard preserving native data points,
 * interpolation and detached curve handles. Paste validates timestamps before
 * creating an animator, uses exact native addKeyframe data, and records the full
 * animation so overwrites, new animators and failures are reversible. Mirroring
 * delegates to native Keyframe.flip, preserving expression and rotation semantics.
 */
export function registerAnimationCopyPasteTool(): void {
  createTool(animationToolDocs[6].name, {
    ...animationToolDocs[6], parameters: animationCopyPasteParameters,
    async execute({ action, source, target }) {
      if (action === "copy") return copySource(source);
      return pasteTarget(target, action === "mirror_paste");
    },
  }, animationToolDocs[6].status);
}
