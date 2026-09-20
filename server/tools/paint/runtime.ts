/// <reference types="three" />
/// <reference types="blockbench-types" />
import { setBarItemValue } from "@/lib/util";
import { isLayerGroupNode } from "./layer-hierarchy";
import { parseOpacityRange, toOpacityRange, type OpacityRange } from "./paint-math";

/**
 * Whether the host has texture layer groups. `TextureLayerGroup` and
 * `TextureLayerItem` were added in Blockbench 5.2; on 5.0/5.1 referencing them
 * throws a ReferenceError, so callers check this first.
 */
export function supportsLayerGroups(): boolean {
  return typeof TextureLayerGroup !== "undefined" && typeof TextureLayerItem !== "undefined";
}

/**
 * Brush preset as stored by Blockbench (`StateMemory.brush_presets` and
 * `Painter.default_brush_presets`). `null` means "leave this setting unchanged"
 * when the preset is loaded; `opacity` is in the active opacity-range units.
 */
export interface IBrushPreset {
  name: string;
  default?: boolean;
  size: number | null;
  opacity: number | null;
  softness: number | null;
  shape: string | null;
  color: string | null;
  blend_mode: string | null;
  pixel_perfect: boolean;
  screen_space: boolean | null;
}

/**
 * Painter members that exist in Blockbench 5.2 (`js/texturing/painter.js`) but
 * are missing or declared read-only in blockbench-types.
 */
export interface IPainterRuntime {
  mirror_painting: boolean;
  lock_alpha: boolean;
  erase_mode: boolean;
  mirror_painting_options?: Record<string, unknown>;
  default_brush_presets?: unknown[];
  colorPicker(texture: Texture, x: number, y: number, event: { button: number }): void;
  loadBrushPreset(preset: unknown): void;
}

/**
 * Returns the Painter global with its untyped 5.2 members declared.
 * Call only inside a tool's `execute`, never at module load.
 */
export function painterRuntime(): IPainterRuntime {
  return Painter as unknown as IPainterRuntime;
}

/**
 * Looks up a Blockbench setting by id without assuming the global exists
 * (it does not in unit tests or outside Blockbench).
 */
export function blockbenchSetting(id: string): Setting | undefined {
  if (typeof settings === "undefined") return undefined;
  return settings[id];
}

/** The active brush opacity range (`settings.opacity_range`, 5.2+); 255 when unavailable. */
export function activeOpacityRange(): OpacityRange {
  return parseOpacityRange(blockbenchSetting("opacity_range")?.value);
}

/**
 * Converts an optional public 0-255 opacity to the active slider range,
 * passing `undefined` through so omitted options stay untouched.
 */
export function brushOpacityForToolbar(opacity: number | undefined): number | undefined {
  return opacity === undefined ? undefined : toOpacityRange(opacity, activeOpacityRange());
}

/** BarItems as a plain record, for ids missing from blockbench-types. */
function barItemRecord(): Record<string, unknown> {
  return BarItems as unknown as Record<string, unknown>;
}

/** Whether a bar item exposes `NumSlider.setValue`. */
function hasSetValue(item: unknown): item is { setValue(value: number): unknown } {
  return typeof item === "object" && item !== null && typeof Reflect.get(item, "setValue") === "function";
}

/**
 * Sets a toolbar value. NumSliders go through `setValue`, which also writes
 * the selected tool's `tool_settings` entry that Painter reads via `get()`;
 * assigning `.value` alone is overwritten by the slider's next `update()`.
 * Other widgets fall back to {@link setBarItemValue}.
 *
 * Select the tool first: slider values are stored per tool.
 */
export function setToolbarValue(id: string, value: unknown): void {
  const item = barItemRecord()[id];
  if (hasSetValue(item) && typeof value === "number") {
    item.setValue(value);
    return;
  }
  setBarItemValue(id, value);
}

/** Applies optional toolbar values in declaration order, leaving `undefined` entries untouched. */
export function applyToolbarValues(values: Record<string, unknown>): void {
  Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .forEach(([id, value]) => setToolbarValue(id, value));
}

/** Tool-like bar item with per-tool settings. */
interface IToolWithSettings {
  tool_settings: Record<string, unknown>;
  brush?: Record<string, unknown>;
}

/** Whether a bar item is a Tool with a `tool_settings` record. */
function isToolWithSettings(item: unknown): item is IToolWithSettings {
  if (typeof item !== "object" || item === null) return false;
  const toolSettings: unknown = Reflect.get(item, "tool_settings");
  return typeof toolSettings === "object" && toolSettings !== null;
}

/**
 * Writes a tool setting on every tool that accepts it, like Blockbench's color
 * picker does for `brush_opacity`, then refreshes the matching slider.
 *
 * @param key - `tool_settings` key, e.g. `brush_opacity`.
 * @param value - Value in the slider's own units.
 * @param accepts - Decides whether a tool takes the setting.
 * @param sliderId - Slider to refresh afterwards.
 * @returns Number of tools updated.
 */
export function setToolSettingOnAllTools(
  key: string,
  value: number,
  accepts: (tool: IToolWithSettings) => boolean,
  sliderId: string
): number {
  const tools = Object.values(barItemRecord()).filter(isToolWithSettings).filter(accepts);
  tools.forEach(tool => {
    tool.tool_settings[key] = value;
  });
  const slider: unknown = barItemRecord()[sliderId];
  if (typeof slider === "object" && slider !== null && typeof Reflect.get(slider, "update") === "function") {
    (slider as { update(): void }).update();
  }
  return tools.length;
}

/**
 * Makes sure painting targets a pixel layer.
 *
 * With 5.2 layer groups, `texture.getActiveLayer()` falls back to
 * `texture.layers[0]`, which can be a group with no canvas; painting would then
 * throw inside Blockbench. When the active item is not a pixel layer, the
 * top-most pixel layer (inside the selected group when possible) is selected.
 *
 * @param texture - Texture about to be painted.
 * @throws Error when layers are enabled but the texture has no pixel layer.
 */
export function ensurePaintableLayer(texture: Texture): void {
  if (!texture.layers_enabled) return;
  const active: unknown = texture.getActiveLayer();
  if (active instanceof TextureLayer) return;
  const selected = texture.selected_layer;
  // Only 5.2 hosts can have group items, so the type check never touches the missing class on 5.0/5.1.
  const selectedGroup = supportsLayerGroups() && selected && isLayerGroupNode(selected) ? (selected as TextureLayerGroup) : undefined;
  const pixelLayers = texture.layers.filter((item): item is TextureLayer => item instanceof TextureLayer);
  const inGroup = selectedGroup ? selectedGroup.getAllChildren().filter((item): item is TextureLayer => item instanceof TextureLayer) : [];
  const target = inGroup.at(-1) ?? pixelLayers.at(-1);
  if (!target) {
    throw new Error(`Texture "${texture.name}" has layers enabled but no pixel layer to paint on. Create one with texture_layer_management action "create_layer".`);
  }
  target.select();
}
