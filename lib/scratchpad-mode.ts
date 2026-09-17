/// <reference types="blockbench-types" />
/**
 * AI Scratchpad: a plugin-registered Blockbench mode where agents can build
 * without the active format's geometry guardrails.
 *
 * Blockbench enforces its project limits on the `ModelFormat`, not on the mode:
 * `cube_size_limiter` (Bedrock/Java block sizes and coordinate limits),
 * `rotation_limit` and `rotation_snap` (single-axis 22.5° steps) and
 * `integer_size`. Selecting the scratchpad relaxes those flags on the live
 * format object and unselecting restores the values captured on entry, leaving
 * alone any flag something else changed meanwhile. Converting the format while
 * inside the scratchpad moves the relaxation to the new format. Leaving the
 * mode never clamps existing geometry; the knife tools conform oversized cubes.
 *
 * Native tools, actions, and panels are gated to `edit` through
 * `{ modes: [...] }` conditions, so the scratchpad is aliased into those arrays
 * (see `lib/scratchpad-aliases.ts`). Host code that reads `Modes.edit`
 * directly (copy/paste, some mesh shortcuts, STL export) stays edit-only.
 *
 * Only the setup/teardown, hooks, and host accessors touch Blockbench globals,
 * so the docs build can import this module outside the host.
 *
 * @module
 */
import { SCRATCHPAD_MODE_ID, SETTING_SCRATCHPAD_ENABLED } from "@/lib/constants";
import { aliasEditMode, collectModeArrays, removeEditAlias } from "@/lib/scratchpad-aliases";

/** Format flags that block or snap agent edits; each is relaxed while the scratchpad is selected. */
export interface IGuardrailFlags {
  rotation_limit: boolean;
  rotation_snap: boolean;
  integer_size: boolean;
  /** Format-provided limiter; `undefined` disables every size and coordinate clamp. */
  cube_size_limiter: unknown;
}

const GUARDRAIL_KEYS = ["rotation_limit", "rotation_snap", "integer_size", "cube_size_limiter"] as const satisfies readonly (keyof IGuardrailFlags)[];

/** Values applied to the format while the scratchpad is active. */
export const RELAXED_GUARDRAILS: Readonly<IGuardrailFlags> = Object.freeze({
  rotation_limit: false,
  rotation_snap: false,
  integer_size: false,
  cube_size_limiter: undefined,
});

/** Undoes a {@link relaxGuardrails} call; safe to invoke more than once. */
export type RestoreGuardrails = () => void;

/** Copies the guardrail flags off a format-like object. */
export function snapshotGuardrails(format: IGuardrailFlags): Readonly<IGuardrailFlags> {
  return Object.freeze({
    rotation_limit: format.rotation_limit,
    rotation_snap: format.rotation_snap,
    integer_size: format.integer_size,
    cube_size_limiter: format.cube_size_limiter,
  });
}

/** Writes guardrail flags onto a format-like object (the host format is shared mutable state). */
export function applyGuardrails(format: IGuardrailFlags, flags: Readonly<Partial<IGuardrailFlags>>): void {
  Object.assign(format, flags);
}

/**
 * Relaxes the guardrails of `format` and returns a function restoring the
 * values captured now. The restore targets the same object even if the global
 * `Format` changes in between, and only restores flags that still hold the
 * relaxed value, so a change made by someone else meanwhile is preserved.
 *
 * @param format - The live format, or `undefined` when no project is open.
 * @returns A restore function; a no-op when there was nothing to relax.
 */
export function relaxGuardrails(format: IGuardrailFlags | undefined | null): RestoreGuardrails {
  if (!format) return () => {};
  const original = snapshotGuardrails(format);
  applyGuardrails(format, RELAXED_GUARDRAILS);
  return () => {
    const current = snapshotGuardrails(format);
    const untouched = GUARDRAIL_KEYS.filter(key => current[key] === RELAXED_GUARDRAILS[key]);
    applyGuardrails(format, Object.fromEntries(untouched.map(key => [key, original[key]])));
  };
}

/** Whether the user enabled the scratchpad toggle in Settings > General. */
export function isScratchpadEnabled(): boolean {
  if (typeof Settings === "undefined") return false;
  return Settings.get(SETTING_SCRATCHPAD_ENABLED) === true;
}

/**
 * Native condition of the scratchpad mode: a project whose format supports
 * edit mode must be open and the setting must be on. Evaluated by Blockbench's
 * mode selector, by `set_mode`, and again on entry because the host restores
 * a project's stored mode through `Mode.select()`, which skips conditions.
 */
export function scratchpadCondition(): boolean {
  if (typeof Project === "undefined" || !Project || typeof Format === "undefined" || !Format) return false;
  return Format.edit_mode === true && isScratchpadEnabled();
}

// blockbench-types 5.0 omits several host events, so the dispatcher is narrowed here.
interface IHostEvents {
  on(event: string, callback: () => void): unknown;
  removeListener(event: string, callback: () => void): unknown;
}

interface IStoredMode {
  mode?: string;
}

let mode: Mode | undefined;
let restoreGuardrails: RestoreGuardrails | undefined;
const aliasedArrays = new Set<string[]>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function liveFormat(): IGuardrailFlags | undefined {
  if (typeof Format === "undefined" || !Format) return undefined;
  return Format as unknown as IGuardrailFlags;
}

function hostRegistries(): Record<string, unknown>[] {
  const registries: unknown[] = [
    typeof BarItems === "undefined" ? undefined : BarItems,
    typeof Panels === "undefined" ? undefined : Panels,
  ];
  return registries.filter(isRecord);
}

/** Re-run on every entry so tools and panels registered by later plugins are covered too. */
function applyEditAlias(): void {
  aliasEditMode(SCRATCHPAD_MODE_ID, collectModeArrays(hostRegistries()), aliasedArrays);
}

/** The grid and Bedrock bounds marker are sized from the limiter, so rebuild them after toggling it. */
function refreshCanvasLimits(): void {
  if (typeof Canvas === "undefined") return;
  (Canvas as unknown as { buildGrid?: () => void }).buildGrid?.();
}

function isScratchpadSelected(): boolean {
  if (typeof Modes === "undefined" || !Modes.selected || typeof Modes.selected !== "object") return false;
  return Modes.selected.id === SCRATCHPAD_MODE_ID;
}

function exitToEdit(): void {
  if (!isScratchpadSelected()) return;
  Modes.options.edit?.trigger();
}

/** Rewrites the stored mode of every project so tab restores never look up a missing or disabled mode. */
function scrubStoredModes(): void {
  if (typeof ModelProject === "undefined") return;
  (ModelProject.all as unknown as IStoredMode[]).forEach(project => {
    if (project.mode === SCRATCHPAD_MODE_ID) project.mode = "edit";
  });
}

function enterScratchpad(): void {
  leaveScratchpad();
  if (!scratchpadCondition()) {
    // Tab restore and undo re-enter through Mode.select(); bounce out once select() has finished.
    queueMicrotask(exitToEdit);
    return;
  }
  applyEditAlias();
  restoreGuardrails = relaxGuardrails(liveFormat());
  refreshCanvasLimits();
}

function leaveScratchpad(): void {
  if (!restoreGuardrails) return;
  restoreGuardrails();
  restoreGuardrails = undefined;
  refreshCanvasLimits();
}

/** Moves the relaxation from the previous format object to the newly selected one. */
function onFormatConverted(): void {
  if (isScratchpadSelected()) enterScratchpad();
}

/** Registers the scratchpad mode with Blockbench; idempotent. */
export function setupScratchpadMode(): void {
  if (mode) return;
  mode = new Mode(SCRATCHPAD_MODE_ID, {
    name: tl("mcp.mode.ai_scratchpad"),
    icon: "science",
    category: "navigate",
    default_tool: "move_tool",
    selectElements: true,
    condition: scratchpadCondition,
    onSelect: enterScratchpad,
    onUnselect: leaveScratchpad,
  });
  applyEditAlias();
  (Blockbench as unknown as IHostEvents).on("convert_format", onFormatConverted);
}

/**
 * Removes the mode. Stored project modes are rewritten first because
 * `Mode.delete()` only rescues the active project, and the keybind entry is
 * released explicitly because `Mode.delete()` skips its parent class cleanup.
 */
export function teardownScratchpadMode(): void {
  if (!mode) return;
  (Blockbench as unknown as IHostEvents).removeListener("convert_format", onFormatConverted);
  scrubStoredModes();
  mode.delete();
  if (typeof KeybindItem !== "undefined") KeybindItem.prototype.delete.call(mode);
  leaveScratchpad();
  removeEditAlias(SCRATCHPAD_MODE_ID, aliasedArrays);
  mode = undefined;
}

/**
 * Setting `onChange` hook. Disabling the toggle returns the active project to
 * Edit through the native trigger and rewrites the stored mode of background
 * tabs; the mode selector is re-rendered because setting values are not reactive.
 */
export function onScratchpadSettingChanged(enabled: unknown): void {
  if (enabled !== true) {
    scrubStoredModes();
    exitToEdit();
  }
  if (typeof Modes === "undefined") return;
  const selector = (Modes as unknown as { vue?: { $forceUpdate?: () => void } }).vue;
  selector?.$forceUpdate?.();
}
