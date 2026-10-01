/// <reference types="three" />
/// <reference types="blockbench-types" />
import { createTool } from "@/lib/factories";
import { getAndActivateTexture } from "@/lib/util";
import { paintToolDocs } from "./docs";
import { createBrushPresetParameters, loadBrushPresetParameters, paintWithBrushParameters } from "./schemas";
import { assertBrushStroke } from "./brush-stroke";
import { nativePaintStroke, startTextureStroke } from "./native-painter";
import { brushPresetAliases, matchesBrushPreset, normalizeHexColor, shortBrushPresetName, toOpacityRange } from "./paint-math";
import {
  activeOpacityRange,
  applyToolbarValues,
  brushOpacityForToolbar,
  ensurePaintableLayer,
  painterRuntime,
  type IBrushPreset,
} from "./runtime";

/**
 * Oldest Blockbench version trusted to stamp a `movePaintTool(..., new_face = true)`
 * move without a line from the previous point, as the 5.2.1 source does; older
 * hosts paint one stroke per point instead.
 */
const SEPARATE_DABS_MIN_VERSION = "5.2.0";

/**
 * Registers `paint_with_brush` (`paintToolDocs[7]`): native strokes with
 * Blockbench's brush tool, so blend mode, pixel-perfect drawing, lock alpha,
 * mirror painting and every other brush setting apply as when painting by
 * hand. Given settings are written to the toolbar first; omitted ones keep the
 * current brush. Painter owns each stroke's undo entry.
 */
export function registerPaintWithBrushTool(): void {
  createTool(
    paintToolDocs[7].name,
    {
      ...paintToolDocs[7],
      parameters: paintWithBrushParameters,
      async execute({ texture_id, coordinates, brush_settings, connect_strokes }) {
        assertBrushStroke(coordinates, connect_strokes);
        const color = brush_settings?.color === undefined ? undefined : normalizeHexColor(brush_settings.color);
        const texture = getAndActivateTexture(texture_id);
        ensurePaintableLayer(texture);

        // Select the tool first: slider values are stored per tool.
        // @ts-ignore
        BarItems.brush_tool.select();
        if (color) ColorPanel.set(color);
        applyToolbarValues({
          slider_brush_size: brush_settings?.size,
          slider_brush_opacity: brushOpacityForToolbar(brush_settings?.opacity),
          slider_brush_softness: brush_settings?.softness,
          slider_brush_aspect_ratio: brush_settings?.aspect_ratio,
          brush_shape: brush_settings?.shape,
          blend_mode: brush_settings?.blend_mode,
        });

        // A move flagged as a new face stamps without a connecting line, so separate dabs can share one stroke.
        // Older hosts paint one stroke per point instead, so the points never turn into lines.
        const oneStroke = connect_strokes || !Blockbench.isOlderThan(SEPARATE_DABS_MIN_VERSION);
        const strokes = oneStroke ? [coordinates] : coordinates.map(point => [point]);
        strokes.forEach(([first, ...rest]) => nativePaintStroke(
          painter => startTextureStroke(painter, texture, first.x, first.y),
          painter => rest.forEach(point => painter.movePaintTool(texture, point.x, point.y, {}, !connect_strokes))
        ));
        Canvas.updateAll();

        return `Painted ${coordinates.length} points on texture "${texture.name}"`;
      },
    },
    paintToolDocs[7].status
  );
}

/**
 * Registers `create_brush_preset` (`paintToolDocs[8]`): appends a preset to
 * `StateMemory.brush_presets` and persists it.
 *
 * Omitted values are stored as `null` like presets made in Blockbench's brush
 * options dialog, so loading the preset leaves those settings untouched. The
 * 0-255 opacity is stored in the active opacity-range units, because
 * `Painter.loadBrushPreset` writes it straight to the opacity slider.
 */
export function registerCreateBrushPresetTool(): void {
  createTool(
    paintToolDocs[8].name,
    {
      ...paintToolDocs[8],
      parameters: createBrushPresetParameters,
      async execute({
        name,
        size,
        opacity,
        softness,
        shape,
        color,
        blend_mode,
        pixel_perfect,
        screen_space,
      }) {
        const preset: IBrushPreset = {
          name,
          size: size ?? null,
          opacity: opacity === undefined ? null : toOpacityRange(opacity, activeOpacityRange()),
          softness: softness ?? null,
          shape: shape ?? null,
          color: color ?? null,
          blend_mode: blend_mode ?? null,
          pixel_perfect: pixel_perfect ?? false,
          screen_space: screen_space ?? null,
        };

        storedBrushPresets().push(preset);
        StateMemory.save("brush_presets");

        return `Created brush preset "${name}" with settings: ${JSON.stringify(
          preset
        )}`;
      },
    },
    paintToolDocs[8].status
  );
}

/** A preset-like object with a string `name`. */
function isNamedPreset(value: unknown): value is { name: string } {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "name") === "string";
}

/** The live `StateMemory.brush_presets` array (custom presets), created if missing. */
function storedBrushPresets(): unknown[] {
  const presets: unknown = StateMemory.brush_presets;
  if (Array.isArray(presets)) return presets;
  StateMemory.brush_presets = [];
  return StateMemory.brush_presets;
}

/** Translated label of a built-in preset name, when Blockbench's `tl` is available. */
function translatePresetName(name: string): string | undefined {
  return typeof tl === "function" ? tl(name) : undefined;
}

/**
 * Finds a preset by name: custom presets by exact name first, then built-in
 * presets (`Painter.default_brush_presets`) by key, short key, or label.
 */
function findBrushPreset(requested: string): { preset: { name: string }; builtIn: boolean } | undefined {
  const custom = storedBrushPresets().filter(isNamedPreset);
  const exact = custom.find(preset => preset.name === requested);
  if (exact) return { preset: exact, builtIn: false };
  const loose = custom.find(preset => matchesBrushPreset(requested, brushPresetAliases(preset.name)));
  if (loose) return { preset: loose, builtIn: false };
  const builtIns = (painterRuntime().default_brush_presets ?? []).filter(isNamedPreset);
  const builtIn = builtIns.find(preset => matchesBrushPreset(requested, brushPresetAliases(preset.name, translatePresetName(preset.name))));
  return builtIn ? { preset: builtIn, builtIn: true } : undefined;
}

/**
 * Registers `load_brush_preset` (`paintToolDocs[9]`): applies a custom or
 * built-in preset by name.
 */
export function registerLoadBrushPresetTool(): void {
  createTool(
    paintToolDocs[9].name,
    {
      ...paintToolDocs[9],
      parameters: loadBrushPresetParameters,
      async execute({ preset_name }) {
        const found = findBrushPreset(preset_name);

        if (!found) {
          const custom = storedBrushPresets().filter(isNamedPreset).map(preset => preset.name);
          const builtIn = (painterRuntime().default_brush_presets ?? []).filter(isNamedPreset).map(preset => shortBrushPresetName(preset.name));
          throw new Error(
            `Brush preset "${preset_name}" not found. Custom presets: ${custom.join(", ") || "none"}. Built-in presets: ${builtIn.join(", ") || "none"}.`
          );
        }

        painterRuntime().loadBrushPreset(found.preset);

        return `Loaded ${found.builtIn ? "built-in" : "custom"} brush preset "${found.preset.name}"`;
      },
    },
    paintToolDocs[9].status
  );
}
