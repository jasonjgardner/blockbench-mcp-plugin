/// <reference types="three" />
/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { getAndActivateTexture } from "@/lib/util";
import { paintToolDocs } from "./docs";
import { createBrushPresetParameters, loadBrushPresetParameters, paintWithBrushParameters } from "./schemas";
import { brushStrokeCoordinates, type IPaintPoint } from "./brush-stroke";
import { brushDimensions, brushPresetAliases, matchesBrushPreset, shortBrushPresetName, toOpacityRange } from "./paint-math";
import {
  activeOpacityRange,
  applyToolbarValues,
  ensurePaintableLayer,
  painterRuntime,
  type IBrushPreset,
} from "./runtime";

/** Brush settings as accepted by `paint_with_brush`; the whole object is optional. */
type BrushSettings = z.infer<typeof paintWithBrushParameters>["brush_settings"];

/** Fully resolved brush state applied to the toolbar and stamped onto the canvas. */
interface IBrushStyle {
  color: string;
  red: number;
  green: number;
  blue: number;
  /** Opacity on the public 0-255 scale. */
  alpha: number;
  size: number;
  /** Softness percentage, 0-100. */
  softness: number;
  shape: "square" | "circle";
  aspectRatio: number;
}

/** RGBA pixel as passed to and returned from Painter's per-pixel callbacks (alpha 0-1). */
interface IRgbaPixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Per-pixel callback of `Painter.editSquare` / `editCircle`. */
type PixelEditor = (pixel: IRgbaPixel, opacity: number, px: number, py: number) => IRgbaPixel;

/**
 * `Painter.editSquare` / `editCircle` as implemented in Blockbench 5.2: the
 * radius may also be a `[width, height]` pair (used for brush aspect ratio),
 * which blockbench-types does not declare.
 */
type BrushStamp = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number | [number, number],
  softness: number,
  editPx: PixelEditor
) => void;

/** Values used for any brush setting the caller omits: a hard, opaque, 1px black square. */
const BRUSH_DEFAULTS = {
  color: "#000000",
  opacity: 255,
  size: 1,
  softness: 0,
  shape: "square",
  aspectRatio: 0,
} as const;

/** Blockbench scales normalized softness by this factor before stamping (see `Painter.useBrush`). */
const NATIVE_SOFTNESS_FACTOR = 1.8;

/** Fills omitted brush settings with defaults and parses the `#RRGGBB` color into channels. */
function resolveBrushStyle(settings: BrushSettings): IBrushStyle {
  const color = settings?.color ?? BRUSH_DEFAULTS.color;
  return {
    color,
    red: parseInt(color.slice(1, 3), 16),
    green: parseInt(color.slice(3, 5), 16),
    blue: parseInt(color.slice(5, 7), 16),
    alpha: settings?.opacity ?? BRUSH_DEFAULTS.opacity,
    size: settings?.size ?? BRUSH_DEFAULTS.size,
    softness: settings?.softness ?? BRUSH_DEFAULTS.softness,
    shape: settings?.shape ?? BRUSH_DEFAULTS.shape,
    aspectRatio: settings?.aspect_ratio ?? BRUSH_DEFAULTS.aspectRatio,
  };
}

/** Mirrors the brush onto Blockbench's toolbar so the UI reflects what was painted. */
function applyBrushStyle(style: IBrushStyle): void {
  applyToolbarValues({
    slider_brush_size: style.size,
    slider_brush_opacity: toOpacityRange(style.alpha, activeOpacityRange()),
    slider_brush_softness: style.softness,
    brush_shape: style.shape,
  });
  ColorPanel.set(style.color);
}

/** The part of a pixel layer the brush needs: growing its canvas to fit a stamp. */
interface IExpandableLayer {
  expandTo(...points: [number, number][]): void;
}

/** Narrows an active layer to one that exposes `expandTo` (pixel layers since 5.0). */
function isExpandableLayer(layer: unknown): layer is IExpandableLayer {
  return typeof layer === "object" && layer !== null && typeof Reflect.get(layer, "expandTo") === "function";
}

/**
 * Grows the active pixel layer so every stamp fits, like `Painter.useBrush`
 * does before each dab; a layer smaller than the texture would otherwise clip
 * strokes that reach past its canvas. No-op when layers are disabled.
 */
function expandActiveLayer(texture: Texture, points: readonly IPaintPoint[], size: number): void {
  if (!texture.layers_enabled) return;
  const layer: unknown = texture.getActiveLayer();
  if (!isExpandableLayer(layer)) return;
  points.forEach(({ x, y }) => layer.expandTo([x - size + 1, y - size + 1], [x + size, y + size]));
}

/**
 * Stamps every sample in order with the brush shape; runs inside `Texture.edit`.
 *
 * Coordinates are texture pixels and are passed through unchanged:
 * `Painter.scanCanvas` already subtracts the active layer's offset. Each pixel
 * is source-over blended with the brush color at the brush opacity times the
 * shape falloff, like Blockbench's own brush.
 */
function stampBrushSamples(texture: Texture, canvas: HTMLCanvasElement, points: IPaintPoint[], style: IBrushStyle): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Brush painting requires a 2D canvas context.");
  const stamp = (style.shape === "circle" ? Painter.editCircle : Painter.editSquare) as unknown as BrushStamp;
  expandActiveLayer(texture, points, style.size);
  const brushColor = { r: style.red, g: style.green, b: style.blue };
  const strength = style.alpha / 255;
  const editPixel: PixelEditor = (pixel, falloff) =>
    Painter.combineColors(pixel, { ...brushColor, a: 1 }, strength * falloff);
  const size = style.aspectRatio ? brushDimensions(style.size, style.aspectRatio) : style.size;
  const softness = (style.softness / 100) * NATIVE_SOFTNESS_FACTOR;
  points.forEach(point => stamp.call(Painter, ctx, point.x, point.y, size, softness, editPixel));
}

/**
 * Registers `paint_with_brush` (`paintToolDocs[7]`): stamps brush samples
 * inside one `Texture.edit`, which owns the undo entry.
 */
export function registerPaintWithBrushTool(): void {
  createTool(
    paintToolDocs[7].name,
    {
      ...paintToolDocs[7],
      parameters: paintWithBrushParameters,
      async execute({ texture_id, coordinates, brush_settings, connect_strokes }) {
        const points = brushStrokeCoordinates(coordinates, connect_strokes);
        const texture = getAndActivateTexture(texture_id);
        ensurePaintableLayer(texture);
        const style = resolveBrushStyle(brush_settings);
        applyBrushStyle(style);

        texture.edit(
          (canvas: HTMLCanvasElement) => stampBrushSamples(texture, canvas, points, style),
          { edit_name: "Paint with brush" }
        );

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
