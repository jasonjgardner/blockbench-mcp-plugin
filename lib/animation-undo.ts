/// <reference types="blockbench-types" />
import { runUndoableEdit } from "@/lib/undo";
import { getAnimationClass } from "@/server/tools/animation/shared";

/** Serialized on our Undo saves so the correction survives history serialization and plugin reloads. */
const RESTORE_MARKER = "mcp_full_animation_restore";
let listening = false;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Mark only saves created from explicitly opted-in MCP transaction aspects. */
function markAnimationSave(event: unknown): void {
  const details = asRecord(event);
  const save = asRecord(details?.save);
  const aspects = asRecord(details?.aspects);
  if (!save || aspects?.[RESTORE_MARKER] !== true || !asRecord(save.animations)) return;
  save[RESTORE_MARKER] = true;
}

/** Native method omitted from published types; it also removes the animator from the timeline. */
interface IAnimationWithRemoval extends BBAnimation {
  removeAnimator(id: string): void;
}

/**
 * Native Animation.extend sets length before replacing frames, so old later keys
 * prevent shrinking. It also keeps animators absent from the saved blueprint.
 * Repair those fields after native loading, before native preview refresh, only
 * for our explicitly marked full-animation saves.
 */
function restoreAnimationSave(event: unknown): void {
  const details = asRecord(event);
  const save = asRecord(details?.save);
  const savedAnimations = asRecord(save?.animations);
  if (save?.[RESTORE_MARKER] !== true || !savedAnimations || typeof Animation === "undefined") return;
  const AnimationClass = getAnimationClass();
  Object.entries(savedAnimations).forEach(([id, raw]) => {
    const saved = asRecord(raw);
    const animation = AnimationClass.all.find(candidate => candidate.uuid === id);
    if (!animation || !saved) return;
    const savedAnimators = asRecord(saved.animators) ?? {};
    Object.entries(animation.animators).filter(([key]) => !Object.hasOwn(savedAnimators, key)).forEach(([key, animator]) => {
      // remove() also drops selected keys; removeAnimator clears timeline references.
      [...animator.keyframes].forEach(frame => frame.remove());
      (animation as IAnimationWithRemoval).removeAnimator(key);
    });
    const length = saved.length;
    if (typeof length !== "number" || !Number.isFinite(length) || length < 0 || length > 10000) return;
    // An Undo snapshot is authoritative, including zero-length automatic playback.
    // Calling setLength would clamp it again; mirror only that method's UI update.
    animation.length = length;
    if (AnimationClass.selected !== animation) return;
    // Published types omit the native Vue data and concrete slider methods.
    const timelineData = asRecord(asRecord(asRecord(Timeline)?.vue)?._data);
    if (timelineData) timelineData.animation_length = length;
    const slider = asRecord(BarItems.slider_animation_length);
    if (slider && typeof slider.update === "function") slider.update();
  });
}

/**
 * Runs one atomic full-animation edit with exact native Undo/Redo/cancellation
 * restoration of animation length and the animator set. The mutable animation
 * array may receive newly created animations during the callback. The plugin's
 * lifecycle must install setupAnimationUndoRestore before tools become callable.
 *
 * @param aspects - Native Undo aspects containing the full animations to snapshot.
 * @param label - The history entry shown to the user.
 * @param edit - Synchronous mutation; errors cancel and restore the complete edit.
 * @returns The mutation callback's result.
 */
export function runUndoableAnimationEdit<T>(aspects: UndoAspects & { animations: BBAnimation[] }, label: string, edit: () => T): T {
  const trackedAspects = { ...aspects, [RESTORE_MARKER]: true };
  return runUndoableEdit(trackedAspects, label, edit);
}

/** Installs idempotent save/load listeners; unmarked native edits retain native behavior. */
export function setupAnimationUndoRestore(): void {
  if (listening) return;
  Blockbench.on("create_undo_save", markAnimationSave);
  Blockbench.on("load_undo_save", restoreAnimationSave);
  listening = true;
}

/** Removes both history listeners when the plugin unloads; safe to call repeatedly. */
export function teardownAnimationUndoRestore(): void {
  if (!listening) return;
  Blockbench.removeListener("create_undo_save", markAnimationSave);
  Blockbench.removeListener("load_undo_save", restoreAnimationSave);
  listening = false;
}
