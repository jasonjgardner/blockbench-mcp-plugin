/**
 * Pure paint helpers with no Blockbench globals, so they can be unit tested
 * outside the Blockbench runtime.
 *
 * @module
 */

/**
 * Scale of Blockbench's brush opacity slider, chosen by the 5.2
 * `opacity_range` setting (`"255"` is the default, `"100"` is a percentage).
 */
export type OpacityRange = 100 | 255;

/** Largest opacity accepted by the public MCP API, which is always 0-255. */
export const MAX_API_OPACITY = 255;

/**
 * Reads a raw `settings.opacity_range.value` into an {@link OpacityRange}.
 *
 * Anything other than `"100"`/`100` (including a missing setting on Blockbench
 * versions before 5.2) means the classic 0-255 scale.
 *
 * @param value - The setting's raw value.
 * @returns `100` or `255`.
 */
export function parseOpacityRange(value: unknown): OpacityRange {
  return value === "100" || value === 100 ? 100 : 255;
}

/**
 * Converts a public 0-255 opacity into the value Blockbench's brush opacity
 * slider (`slider_brush_opacity` / `tool_settings.brush_opacity`) expects.
 *
 * The Painter divides the slider value by the active range, so a 0-255 value
 * must be rescaled when the range is 0-100. Percentages keep two decimals.
 *
 * @param opacity - Opacity on the 0-255 scale; clamped to that range.
 * @param range - The active opacity range.
 * @returns The equivalent slider value.
 */
export function toOpacityRange(opacity: number, range: OpacityRange): number {
  const clamped = Math.min(MAX_API_OPACITY, Math.max(0, opacity));
  if (range === 255) return clamped;
  return Math.round((clamped / MAX_API_OPACITY) * 100 * 100) / 100;
}

/**
 * Converts a slider value in the active range back to the public 0-255 scale.
 *
 * @param value - Slider value in `range` units; clamped to that range.
 * @param range - The active opacity range.
 * @returns Opacity on the 0-255 scale, rounded to an integer.
 */
export function fromOpacityRange(value: number, range: OpacityRange): number {
  const clamped = Math.min(range, Math.max(0, value));
  return Math.round((clamped / range) * MAX_API_OPACITY);
}

/**
 * Converts a picked pixel alpha (0-1) to a 0-255 opacity the way Blockbench's
 * color picker does (`floor(alpha * 256)`), capped at 255.
 *
 * @param alpha - Pixel alpha between 0 and 1.
 * @returns Opacity on the 0-255 scale.
 */
export function alphaToOpacity(alpha: number): number {
  return Math.min(MAX_API_OPACITY, Math.max(0, Math.floor(alpha * 256)));
}

/**
 * Brush footprint `[width, height]` in texture pixels for a size and aspect
 * ratio, mirroring `Painter.getBrushDimensions` in Blockbench 5.2.
 *
 * A negative aspect ratio narrows the width, a positive one narrows the
 * height; `0` keeps the brush square/round.
 *
 * @param size - Brush size in pixels.
 * @param aspectRatio - Aspect ratio between -16 and 16.
 * @returns `[width, height]`.
 */
export function brushDimensions(size: number, aspectRatio: number): [number, number] {
  if (!aspectRatio) return [size, size];
  const narrowed = Math.round(size / (Math.abs(aspectRatio) + 1));
  return aspectRatio < 0 ? [narrowed, size] : [size, narrowed];
}

/** Translation-key prefix Blockbench uses for its built-in brush preset names. */
const DEFAULT_PRESET_PREFIX = "menu.brush_presets.";

/**
 * Short name of a preset: built-in keys lose their `menu.brush_presets.`
 * prefix (`menu.brush_presets.screen_space` -> `screen_space`); custom names
 * are returned unchanged.
 */
export function shortBrushPresetName(name: string): string {
  return name.startsWith(DEFAULT_PRESET_PREFIX) ? name.slice(DEFAULT_PRESET_PREFIX.length) : name;
}

/**
 * Names a brush preset can be requested by: the stored name, the built-in key
 * without its `menu.brush_presets.` prefix (e.g. `screen_space`), and the
 * translated label when one is available.
 *
 * @param name - The preset's stored `name`.
 * @param translated - Optional translated label for built-in presets.
 * @returns Lower-cased, trimmed aliases without duplicates.
 */
export function brushPresetAliases(name: string, translated?: string): string[] {
  const aliases = [name, shortBrushPresetName(name), translated ?? name];
  return [...new Set(aliases.map(alias => alias.trim().toLowerCase()))];
}

/**
 * Whether `requested` names a preset with the given aliases (case-insensitive).
 *
 * @param requested - Name passed by the caller.
 * @param aliases - Output of {@link brushPresetAliases}.
 */
export function matchesBrushPreset(requested: string, aliases: readonly string[]): boolean {
  return aliases.includes(requested.trim().toLowerCase());
}
