/**
 * Pure playhead-relative keyframe filtering, free of Blockbench globals so it
 * can be unit tested and imported by the documentation build.
 *
 * @module
 */

/**
 * Tolerance, in seconds, Blockbench 5.2 applies when comparing keyframe times
 * to the playhead in `keyframe_select_before_playhead` /
 * `keyframe_select_after_playhead` (js/animations/keyframe.js). Keyframes
 * sitting exactly on the playhead are included in both directions.
 */
export const PLAYHEAD_EPSILON = 1e-5;

/** Which side of the playhead to select; the playhead frame itself counts for both. */
export type PlayheadDirection = "before" | "after";

/** Predicates matching Blockbench's native playhead comparisons, keyed by direction. */
const PLAYHEAD_PREDICATES: Record<PlayheadDirection, (frameTime: number, playhead: number) => boolean> = {
  before: (frameTime, playhead) => frameTime < playhead + PLAYHEAD_EPSILON,
  after: (frameTime, playhead) => frameTime > playhead - PLAYHEAD_EPSILON,
};

/**
 * Keeps the frames at or before (or at or after) `playhead`, using the same
 * inclusive 1e-5 second tolerance as Blockbench's native actions.
 *
 * @param frames - Candidate keyframes; only their `time` (seconds) is read.
 * @param playhead - Reference time in seconds.
 * @param direction - `before` keeps `time <= playhead`, `after` keeps `time >= playhead` (within tolerance).
 * @returns A new array preserving the input order.
 */
export function filterFramesByPlayhead<T extends { readonly time: number }>(
  frames: readonly T[],
  playhead: number,
  direction: PlayheadDirection
): T[] {
  const matches = PLAYHEAD_PREDICATES[direction];
  return frames.filter((frame) => matches(frame.time, playhead));
}
