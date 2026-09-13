/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { runUndoableAnimationEdit } from "@/lib/animation-undo";
import { animationToolDocs } from "./docs";
import { animationTimelineParameters } from "./schemas";
import { findAnimationOrSelected, replaceTimelineSelection } from "./shared";

type TimelineInput = z.infer<typeof animationTimelineParameters>;
type TimelineAction = TimelineInput["action"];

/** A validated timeline request with the target animation's keyframes precomputed. */
interface ITimelineRequest {
  animation: _Animation;
  input: TimelineInput;
  allFrames: _Keyframe[];
  lastTime: number;
}

/**
 * Per-action checks for the parameter each action requires. Each returns the
 * error message when the request is unusable, or `undefined` when it is valid.
 */
const TIMELINE_INPUT_CHECKS: Partial<Record<TimelineAction, (input: TimelineInput) => string | undefined>> = {
  set_time: ({ time }) => (time === undefined ? "Time parameter required for set_time action." : undefined),
  set_length: ({ length }) => (length === undefined ? "Length parameter required for set_length action." : undefined),
  set_fps: ({ fps }) => (fps === undefined ? "FPS parameter required for set_fps action." : undefined),
  loop: ({ loop_mode }) => (loop_mode === undefined ? "loop_mode parameter required for loop action." : undefined),
  select_range: ({ range }) => (!range || range.start > range.end ? "An ordered range is required for select_range action." : undefined),
};

/**
 * Timeline handlers keyed by action. Playback actions select the target and
 * drive the global timeline; settings actions edit the target in one undo
 * entry without changing the selection; `select_range` replaces the keyframe
 * selection. Each returns the tool's result message.
 */
const TIMELINE_HANDLERS: Record<TimelineAction, (request: ITimelineRequest) => string> = {
  play: (request) => runPlayback(request, () => {
    Modes.options.animate.select();
    Timeline.start();
  }),
  pause: (request) => runPlayback(request, () => Timeline.pause()),
  stop: (request) => runPlayback(request, () => {
    Timeline.pause();
    Timeline.setTime(0);
  }),
  set_time: (request) => runPlayback(request, () => {
    Modes.options.animate.select();
    if (request.input.time !== undefined) Timeline.setTime(request.input.time);
  }),
  set_length: setAnimationLength,
  set_fps: (request) => runTimelineEdit(request, (animation, { fps }) => {
    if (fps !== undefined) animation.snapping = fps;
  }),
  loop: (request) => runTimelineEdit(request, (animation, { loop_mode }) => {
    if (loop_mode) animation.setLoop(loop_mode, false);
  }),
  select_range: selectKeyframeRange,
};

/** Selects the target animation, runs a playback control, and refreshes the preview. */
function runPlayback({ animation, input }: ITimelineRequest, control: () => void): string {
  animation.select();
  control();
  Animator.preview();
  return `Animation timeline: ${input.action}`;
}

/** Applies an animation setting in one undo entry, reverting it if the preview fails. */
function runTimelineEdit(
  { animation, input }: ITimelineRequest,
  apply: (animation: _Animation, input: TimelineInput) => void
): string {
  runUndoableAnimationEdit({ animations: [animation] }, `Animation timeline: ${input.action}`, () => {
    apply(animation, input);
    Animator.preview();
  });
  return `Updated animation ${animation.name}: ${input.action}`;
}

/**
 * Sets the animation length without truncating existing keyframes.
 * @throws When the requested length ends before the last keyframe.
 */
function setAnimationLength(request: ITimelineRequest): string {
  const { input: { length }, lastTime } = request;
  if (length !== undefined && length < lastTime) {
    throw new Error(`Length must include the last keyframe at ${lastTime} seconds.`);
  }
  return runTimelineEdit(request, (animation) => animation.setLength(length));
}

/** Replaces the timeline selection with every keyframe inside the inclusive range. */
function selectKeyframeRange({ animation, input: { range }, allFrames }: ITimelineRequest): string {
  if (!range) throw new Error("An ordered range is required for select_range action.");
  const selected = allFrames.filter((frame) => frame.time >= range.start && frame.time <= range.end);
  replaceTimelineSelection(animation, selected, "Select animation range");
  return `Selected ${selected.length} keyframes between ${range.start} and ${range.end} seconds`;
}

/**
 * Registers `animation_timeline`, which controls playback, scrubbing, length,
 * FPS, loop mode, and range selection. Call only after Blockbench globals exist.
 */
export function registerAnimationTimelineTool(): void {
  createTool(
    animationToolDocs[4].name,
    {
      ...animationToolDocs[4],
      parameters: animationTimelineParameters,
      async execute(input) {
        const animation = findAnimationOrSelected(input.animation_id);
        if (!animation) throw new Error("No animation found or selected.");
        const inputError = TIMELINE_INPUT_CHECKS[input.action]?.(input);
        if (inputError) throw new Error(inputError);
        const allFrames = Object.values<GeneralAnimator>(animation.animators).flatMap((animator) => animator.keyframes);
        const lastTime = Math.max(0, ...allFrames.map((frame) => frame.time));
        return TIMELINE_HANDLERS[input.action]({ animation, input, allFrames, lastTime });
      },
    },
    animationToolDocs[4].status
  );
}
