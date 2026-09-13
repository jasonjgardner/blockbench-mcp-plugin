/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { findGroupOrThrow } from "@/lib/util";
import { runUndoableAnimationEdit } from "@/lib/animation-undo";
import { animationToolDocs } from "./docs";
import { manageKeyframesParameters } from "./schemas";
import {
  KEYFRAME_TIME_EPSILON,
  applyKeyframeValues,
  findAnimationOrSelected,
  replaceTimelineSelection,
  toVector3,
} from "./shared";

type ManageKeyframesInput = z.infer<typeof manageKeyframesParameters>;
type KeyframeInput = ManageKeyframesInput["keyframes"][number];
type BezierHandlesInput = NonNullable<KeyframeInput["bezier_handles"]>;
type KeyframeEditAction = Exclude<ManageKeyframesInput["action"], "select">;

/** One requested keyframe paired with the existing keyframe at its time, if any. */
interface IKeyframeEdit {
  animator: BoneAnimator;
  channel: ManageKeyframesInput["channel"];
  data: KeyframeInput;
  existing: _Keyframe | undefined;
}

/**
 * Model-editing actions, applied per requested keyframe inside one undo edit.
 * `create` replaces any keyframe already at the requested time; `edit` and
 * `delete` only run after every requested time was matched.
 */
const KEYFRAME_EDITORS: Record<KeyframeEditAction, (edit: IKeyframeEdit) => void> = {
  create: ({ animator, channel, data, existing }) => {
    existing?.remove();
    writeKeyframeData(animator.addKeyframe({ time: data.time, channel, interpolation: data.interpolation, data_points: [{}] }), data);
  },
  delete: ({ existing }) => {
    existing?.remove();
  },
  edit: ({ data, existing }) => writeKeyframeData(existing, data),
};

/**
 * Rejects empty requests, invalid times, and repeated times before any
 * animator, selection, or undo state is touched.
 * @throws With distinct messages for invalid and duplicate times.
 */
function assertRequestedKeyframeTimes(keyframes: KeyframeInput[]): void {
  if (!keyframes.length || keyframes.some(({ time }) => !Number.isFinite(time) || time < 0)) {
    throw new Error("Provide at least one keyframe with a finite, nonnegative time.");
  }
  if (new Set(keyframes.map(({ time }) => time)).size !== keyframes.length) {
    throw new Error("Duplicate requested keyframe times are not supported; provide each timestamp once.");
  }
}

/**
 * Finds the existing keyframe at each requested time without creating an
 * animator, so a failed request leaves `animation.animators` untouched.
 * @returns One entry per requested keyframe; `undefined` where none exists.
 */
function matchExistingKeyframes(
  animation: _Animation,
  group: Group,
  channel: ManageKeyframesInput["channel"],
  keyframes: KeyframeInput[]
): (_Keyframe | undefined)[] {
  const existingFrames: _Keyframe[] = animation.animators[group.uuid]?.[channel] ?? [];
  return keyframes.map((data) => existingFrames.find((frame) => Math.abs(frame.time - data.time) < KEYFRAME_TIME_EPSILON));
}

/** Copies requested bezier handles onto a keyframe, expanding uniform numbers per axis. */
function applyBezierHandles(frame: _Keyframe, handles: BezierHandlesInput): void {
  if (handles.left_time !== undefined) frame.bezier_left_time = toVector3(handles.left_time);
  if (handles.right_time !== undefined) frame.bezier_right_time = toVector3(handles.right_time);
  if (handles.left_value !== undefined) frame.bezier_left_value = toVector3(handles.left_value);
  if (handles.right_value !== undefined) frame.bezier_right_value = toVector3(handles.right_value);
}

/**
 * Writes requested values, interpolation, and bezier handles to a keyframe.
 * @throws When the target keyframe could not be resolved.
 */
function writeKeyframeData(frame: _Keyframe | undefined, data: KeyframeInput): void {
  if (!frame) throw new Error("Could not resolve the target keyframe.");
  if (data.values !== undefined) applyKeyframeValues(frame, data.values);
  if (data.interpolation) frame.interpolation = data.interpolation;
  if (data.interpolation === "bezier" && data.bezier_handles) applyBezierHandles(frame, data.bezier_handles);
}

/**
 * Registers `manage_keyframes`, which creates, edits, deletes, or selects
 * keyframes on one bone channel. Call only after Blockbench globals exist.
 */
export function registerManageKeyframesTool(): void {
  createTool(
    animationToolDocs[1].name,
    {
      ...animationToolDocs[1],
      parameters: manageKeyframesParameters,
      async execute({ animation_id, action, bone_name, channel, keyframes }) {
        const animation = findAnimationOrSelected(animation_id);
        if (!animation) throw new Error("No animation found or selected.");
        const group = findGroupOrThrow(bone_name);
        assertRequestedKeyframeTimes(keyframes);
        const matches = matchExistingKeyframes(animation, group, channel, keyframes);
        if (action !== "create" && matches.some((frame) => !frame)) {
          throw new Error("No keyframe exists at one or more requested times; no keyframes changed.");
        }
        if (action === "select") {
          replaceTimelineSelection(animation, matches, "Select keyframes");
          return `Selected ${matches.length} keyframes for ${bone_name}.${channel}`;
        }

        runUndoableAnimationEdit({ animations: [animation] }, `${action} keyframes`, () => {
          const animator = animation.getBoneAnimator(group);
          keyframes.forEach((data, index) => KEYFRAME_EDITORS[action]({ animator, channel, data, existing: matches[index] }));
          animation.setLength();
          Animator.preview();
        });
        return `Successfully performed ${action} on ${keyframes.length} keyframes for ${bone_name}.${channel}`;
      },
    },
    animationToolDocs[1].status
  );
}
