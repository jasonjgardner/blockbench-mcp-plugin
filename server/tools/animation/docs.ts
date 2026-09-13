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
