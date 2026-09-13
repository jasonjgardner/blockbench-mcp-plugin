/// <reference types="three" />
/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { getAndActivateTexture } from "@/lib/util";
import { paintToolDocs } from "./docs";
import { createBrushPresetParameters, loadBrushPresetParameters, paintWithBrushParameters } from "./schemas";
import { brushStrokeCoordinates, type IPaintPoint } from "./brush-stroke";

/** Brush settings as accepted by `paint_with_brush`; the whole object is optional. */
type BrushSettings = z.infer<typeof paintWithBrushParameters>["brush_settings"];

/** Fully resolved brush state applied to the toolbar and stamped onto the canvas. */
interface IBrushStyle {
  color: string;
  red: number;
  green: number;
  blue: number;
  alpha: number;
  size: number;
  softness: number;
  shape: "square" | "circle";
}

/** Values used for any brush setting the caller omits: a hard, opaque, 1px black square. */
const BRUSH_DEFAULTS = {
  color: "#000000",
  opacity: 255,
  size: 1,
  softness: 0,
  shape: "square",
} as const;

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
  };
}

/** Mirrors the brush onto Blockbench's toolbar so the UI reflects what was painted. */
function applyBrushStyle(style: IBrushStyle): void {
  // @ts-ignore
  BarItems.slider_brush_size.value = style.size;
  // @ts-ignore
  BarItems.slider_brush_opacity.value = style.alpha;
  // @ts-ignore
  BarItems.slider_brush_softness.value = style.softness;
  // @ts-ignore
  BarItems.brush_shape.value = style.shape;
  ColorPanel.set(style.color);
}

/** Stamps every sample in order with the brush shape; runs inside `Texture.edit`. */
function stampBrushSamples(canvas: HTMLCanvasElement, points: IPaintPoint[], style: IBrushStyle): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Brush painting requires a 2D canvas context.");
  const stamp = style.shape === "circle" ? "editCircle" : "editSquare";
  const pixelColor = () => ({ r: style.red, g: style.green, b: style.blue, a: style.alpha });
  points.forEach(point => Painter[stamp](ctx, point.x, point.y, style.size, style.softness, pixelColor));
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
        const style = resolveBrushStyle(brush_settings);
        applyBrushStyle(style);

        texture.edit(
          (canvas: HTMLCanvasElement) => stampBrushSamples(canvas, points, style),
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
      }) {
        const preset = {
          name,
          size: size ?? null,
          opacity: opacity ?? null,
          softness: softness ?? null,
          shape: shape || "square",
          color: color || null,
          blend_mode: blend_mode || "default",
          pixel_perfect: pixel_perfect || false,
        };

        // @ts-ignore
        StateMemory.brush_presets.push(preset);
        // @ts-ignore
        StateMemory.save("brush_presets");

        return `Created brush preset "${name}" with settings: ${JSON.stringify(
          preset
        )}`;
      },
    },
    paintToolDocs[8].status
  );
}

/**
 * Registers `load_brush_preset` (`paintToolDocs[9]`): applies a stored preset
 * by exact name.
 */
export function registerLoadBrushPresetTool(): void {
  createTool(
    paintToolDocs[9].name,
    {
      ...paintToolDocs[9],
      parameters: loadBrushPresetParameters,
      async execute({ preset_name }) {
        // @ts-ignore
        const preset = StateMemory.brush_presets.find(
          (p) => p.name === preset_name
        );

        if (!preset) {
          throw new Error(`Brush preset "${preset_name}" not found.`);
        }

        // @ts-ignore
        Painter.loadBrushPreset(preset);

        return `Loaded brush preset "${preset_name}"`;
      },
    },
    paintToolDocs[9].status
  );
}
