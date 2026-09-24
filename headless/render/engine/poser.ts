import { InterpolateDiscrete, LoopOnce, type AnimationAction, type AnimationClip, type AnimationMixer } from "three";

import type { IClipTiming, LoopMode } from "./timeline";

/** Poses a model at an exact clip time, in any order, without a clock. */
export interface IPoser {
  /** Applies the pose at `time` seconds. Times past the end of a non-looping clip hold its last pose. */
  pose(time: number): void;
}

/**
 * Wraps a mixer so every sample starts from a fresh action.
 *
 * three.js pauses a LoopOnce action once `setTime` passes its end, and `AnimationMixer.setTime`
 * never un-pauses it, so later samples would all show time 0. Resetting before each sample makes
 * frames independent of sampling order. `clampWhenFinished` holds the final pose past the end,
 * which suits renders (Blockbench itself snaps "once" clips back to rest).
 *
 * Pass `loop` when the action's loop mode was not already set by the loader. Without LoopOnce, a
 * sample at exactly the clip end wraps to time 0 and shows the first frame instead of the last.
 */
export function createPoser(mixer: AnimationMixer, action: AnimationAction, loop?: LoopMode): IPoser {
  if (loop !== undefined && loop !== "loop") action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  return {
    pose(time) {
      action.reset();
      action.play();
      mixer.setTime(time);
    },
  };
}

/** True when any track holds its value between keys, as Blockbench "step" keyframes do. */
export const isStepped = (clip: AnimationClip): boolean =>
  clip.tracks.some((track) => track.getInterpolation() === InterpolateDiscrete);

/**
 * Timing for a clip loaded by three-blockbench, read from the Blockbench animation it came from.
 * Blockbench defaults an unset loop mode to "once".
 */
export function blockbenchClipTiming(clip: AnimationClip): IClipTiming {
  const source = clip.userData["blockbenchAnimation"] as { loop?: LoopMode; snapping?: number } | undefined;
  const base: IClipTiming = { duration: clip.duration, loop: source?.loop ?? "once", stepped: isStepped(clip) };
  return source?.snapping === undefined ? base : { ...base, snapping: source.snapping };
}
