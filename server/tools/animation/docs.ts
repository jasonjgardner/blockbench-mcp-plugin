import type { IToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import {
  createAnimationParameters,
  manageKeyframesParameters,
  animationGraphEditorParameters,
  boneRiggingParameters,
  animationTimelineParameters,
  batchKeyframeOperationsParameters,
  animationCopyPasteParameters,
} from "./schemas";

/**
 * Public contracts for every animation tool, free of Blockbench runtime globals
 * so the documentation generator can import them outside Blockbench.
 *
 * Registration reads these entries by index, so the order is part of the
 * contract: `[0]` create_animation, `[1]` manage_keyframes,
 * `[2]` animation_graph_editor, `[3]` bone_rigging, `[4]` animation_timeline,
 * `[5]` batch_keyframe_operations, `[6]` animation_copy_paste.
 */
export const animationToolDocs: IToolSpec[] = [
  {
    name: "create_animation",
    condition: { project: true, features: ["animation_mode"] },
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
    condition: { project: true, features: ["animation_mode"] },
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
    condition: { project: true, features: ["animation_mode"] },
    description:
      "Edits a bone channel's interpolation or numeric Bezier easing in one reversible edit. Uses native per-axis handle arrays and chronological segment durations. Custom points are normalized time/value fractions. Partial-axis edits require existing Bezier keys; key-wide mode changes require all axes. Rejects curve edits ignored by quaternion rotation. Inspect neighboring segments after range edits.",
    annotations: {
      title: "Animation Graph Editor",
      destructiveHint: true,
    },
    parameters: animationGraphEditorParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "bone_rigging",
    condition: { project: true, features: ["bone_rig"] },
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
    condition: { project: true, features: ["animation_mode"] },
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
    condition: { project: true, features: ["animation_mode"] },
    description: "Edits keyframes in the active animation atomically; all includes hidden animators. Numeric value edits use native transform values. Bake samples continuous numeric curves within selected channel spans, caps output at 10000 samples, and restores the playhead. Expressions, step/pre-post curves and effect channels require native baking.",
    annotations: {
      title: "Batch Keyframe Operations",
      destructiveHint: true,
    },
    parameters: batchKeyframeOperationsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "animation_copy_paste",
    condition: { project: true, features: ["animation_mode"] },
    description:
      "Copies native keyframe data points and curve metadata into a plugin-local clipboard. Paste preserves exact timestamps, replaces same-channel/time collisions and is undoable, including newly created animators. Mirror paste uses native position/rotation/curve mirroring; scale is unchanged.",
    annotations: {
      title: "Animation Copy/Paste",
      destructiveHint: true,
    },
    parameters: animationCopyPasteParameters,
    status: STATUS_EXPERIMENTAL,
  },
];
