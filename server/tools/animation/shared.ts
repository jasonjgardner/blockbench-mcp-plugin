/// <reference types="blockbench-types" />

/**
 * Transform channels a bone animator stores keyframes for, in the order
 * `create_animation` validates and writes them for each requested time.
 */
export const TRANSFORM_CHANNELS = ["position", "rotation", "scale"] as const;

/**
 * Seconds within which a requested time addresses an existing keyframe.
 * Absorbs floating-point drift between agent-supplied times and the times
 * Blockbench stores, while staying far below one frame at the maximum FPS.
 */
export const KEYFRAME_TIME_EPSILON = 0.001;

/**
 * Returns Blockbench's runtime `Animation` class with its real static API.
 *
 * blockbench-types cannot override libdom's global `Animation` (Web Animations)
 * declaration, so the Blockbench class is only typed as `BBAnimation`. This is
 * the single bridge between the two; tools must not repeat the cast. Call it
 * at runtime only — the global does not exist when docs import this module.
 *
 * @returns The `Animation` constructor, including `all` and `selected`.
 */
export function getAnimationClass(): typeof BBAnimation {
  return Animation as unknown as typeof BBAnimation;
}

/**
 * Resolves the animation a tool acts on: an explicit UUID/name match, or the
 * currently selected animation when no identifier is given.
 *
 * @param animationId - Animation UUID or name; empty or omitted uses the selection.
 * @returns The matching animation, or `undefined`/`null` when nothing matches
 *   or nothing is selected. Callers own the "not found" message.
 */
export function findAnimationOrSelected(animationId?: string): BBAnimation | null | undefined {
  const AnimationClass = getAnimationClass();
  return animationId
    ? AnimationClass.all.find((item) => item.uuid === animationId || item.name === animationId)
    : AnimationClass.selected;
}

/**
 * Expands a uniform number to `[v, v, v]`, or copies the first three
 * components of an `[x, y, z]` array. Keyframe data points and bezier handles
 * are stored per axis, while agents may send one uniform value.
 *
 * @param value - A uniform scalar or a schema-validated three-component array.
 * @returns A new three-component tuple.
 */
export function toVector3(value: number | number[]): ArrayVector3 {
  return Array.isArray(value) ? [value[0], value[1], value[2]] : [value, value, value];
}

/**
 * Applies a keyframe's data-point values through Blockbench's real per-axis
 * `Keyframe.set()` API. A bare number (uniform scale) is expanded to all three
 * axes; a `[x, y, z]` array is written component-wise.
 *
 * `Keyframe.extend()` only merges registered properties, so a `values` key is
 * silently dropped and `set("values", …)` writes a stray, unread property —
 * which is why `manage_keyframes` used to leave every data point at its channel
 * default. Scale keyframes also default to `uniform: true`, where `set()`
 * mirrors one value to all axes, so the flag is cleared before writing
 * genuinely non-uniform components; otherwise x/y/z collapse to the last write.
 *
 * @param keyframe - The keyframe to write to.
 * @param values - `[x, y, z]` for position/rotation, or a number for uniform scale.
 */
export function applyKeyframeValues(
  keyframe: BBKeyframe,
  values: number[] | number
): void {
  const vals = toVector3(values);
  if (keyframe.uniform && new Set(vals).size > 1) {
    keyframe.uniform = false;
  }
  keyframe.set("x", vals[0]);
  keyframe.set("y", vals[1]);
  keyframe.set("z", vals[2]);
}

/**
 * Replaces the timeline keyframe selection as one selection-history entry.
 *
 * The animation is selected first because Blockbench only exposes keyframes of
 * the active animation. Previously selected frames are cleared, then `frames`
 * are added with ctrl semantics so selecting one never deselects another.
 *
 * @param animation - Animation that owns `frames`.
 * @param frames - Keyframes to select; `undefined` entries are skipped.
 * @param label - Selection history label shown in Blockbench.
 */
export function replaceTimelineSelection(
  animation: BBAnimation,
  frames: readonly (BBKeyframe | undefined)[],
  label: string
): void {
  Undo.initSelection({ timeline: true });
  animation.select();
  Timeline.selected.forEach((frame) => { frame.selected = false; });
  Timeline.selected.splice(0);
  frames.forEach((frame) => frame?.select({ ctrlOrCmd: true }));
  updateKeyframeSelection();
  Undo.finishSelection(label);
}

/**
 * Returns the bone animator for `node`, creating it when needed.
 *
 * Blockbench 5.2 `getBoneAnimator()` returns nothing when the node type has no
 * animator or, under a scope-isolated multi-file ruleset, when the node lives
 * in a different scope than the animation. Tools must surface that as a clear
 * error instead of dereferencing `null`. Call inside an undoable edit so a
 * newly created animator is rolled back if a later step fails.
 *
 * @param animation - Animation that should own the animator.
 * @param node - Bone/group (or other animatable outliner node) to animate.
 * @returns The existing or newly created bone animator.
 * @throws When Blockbench cannot provide an animator for this node.
 */
export function requireBoneAnimator(animation: BBAnimation, node: OutlinerNode): BoneAnimator {
  const animator = animation.getBoneAnimator(node);
  if (animator) return animator;
  throw new Error(
    `"${node.name}" cannot be animated by "${animation.name}". It may not support animation, or it belongs to a different scope than this animation.`
  );
}
