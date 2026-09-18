/// <reference types="three" />
/// <reference types="blockbench-types" />
import { createTool } from "@/lib/factories";
import { getAndActivateTexture, setBarItemValue } from "@/lib/util";
import { paintToolDocs } from "./docs";
import {
  paintFillToolParameters,
  drawShapeToolParameters,
  gradientToolParameters,
  copyBrushToolParameters,
  eraserToolParameters,
} from "./schemas";
import { nativePaintStroke, setCopyBrushSource, startTextureStroke } from "./native-painter";

/** Applies optional toolbar values in declaration order, leaving omitted (undefined) options untouched. */
function applyToolbarValues(values: Record<string, unknown>): void {
  Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .forEach(([id, value]) => setBarItemValue(id, value));
}

/**
 * Registers `paint_fill_tool` (`paintToolDocs[0]`): a native bucket fill that
 * owns its own undo entry. Must run before tools are listed; Blockbench globals
 * are only touched when the tool executes.
 */
export function registerPaintFillTool(): void {
  createTool(
    paintToolDocs[0].name,
    {
      ...paintToolDocs[0],
      parameters: paintFillToolParameters,
      async execute({ texture_id, x, y, color, opacity, tolerance, fill_mode, blend_mode }) {
        if (tolerance !== undefined && tolerance !== 0) throw new Error("Native fill supports exact color matching only. Omit tolerance or set it to 0; nonzero tolerance is unsupported.");
        const texture = getAndActivateTexture(texture_id);

        // Apply settings
        if (color) {
          ColorPanel.set(color);
        }
        applyToolbarValues({ slider_brush_opacity: opacity, fill_mode, blend_mode });

        // Select fill tool
        // @ts-ignore
        BarItems.fill_tool.select();

        // Perform fill
        nativePaintStroke(painter => startTextureStroke(painter, texture, x, y));
        Canvas.updateAll();

        return `Filled area at (${x}, ${y}) on texture "${texture.name}"`;
      },
    },
    paintToolDocs[0].status
  );
}

/**
 * Registers `draw_shape_tool` (`paintToolDocs[1]`): one native shape stroke
 * from `start` to `end`, committed as a single undo entry.
 */
export function registerDrawShapeTool(): void {
  createTool(
    paintToolDocs[1].name,
    {
      ...paintToolDocs[1],
      parameters: drawShapeToolParameters,
      async execute({ texture_id, shape, start, end, color, line_width, opacity, blend_mode }) {
        const texture = getAndActivateTexture(texture_id);

        // Apply settings
        if (color) {
          ColorPanel.set(color);
        }
        applyToolbarValues({ slider_brush_opacity: opacity, slider_brush_size: line_width, blend_mode });

        // Set shape type
        setBarItemValue("draw_shape_type", shape);

        // Select draw shape tool
        // @ts-ignore
        BarItems.draw_shape_tool.select();

        // Draw shape
        nativePaintStroke(
          painter => startTextureStroke(painter, texture, start.x, start.y),
          painter => painter.useShapeTool(texture, end.x, end.y, {})
        );
        Canvas.updateAll();

        return `Drew ${shape} from (${start.x}, ${start.y}) to (${end.x}, ${end.y}) on texture "${texture.name}"`;
      },
    },
    paintToolDocs[1].status
  );
}

/**
 * Registers `gradient_tool` (`paintToolDocs[2]`): a native gradient stroke
 * using `start_color` as primary and `end_color` as secondary color.
 */
export function registerGradientTool(): void {
  createTool(
    paintToolDocs[2].name,
    {
      ...paintToolDocs[2],
      parameters: gradientToolParameters,
      async execute({ texture_id, start, end, start_color, end_color, opacity, blend_mode }) {
        const texture = getAndActivateTexture(texture_id);

        // Apply settings
        ColorPanel.set(start_color);
        // @ts-ignore
        ColorPanel.set(end_color, true); // Set as secondary color
        applyToolbarValues({ slider_brush_opacity: opacity, blend_mode });

        // Select gradient tool
        // @ts-ignore
        BarItems.gradient_tool.select();

        // Apply gradient
        nativePaintStroke(
          painter => startTextureStroke(painter, texture, start.x, start.y),
          painter => painter.useGradientTool(texture, end.x, end.y, {})
        );
        Canvas.updateAll();

        return `Applied gradient from (${start.x}, ${start.y}) to (${end.x}, ${end.y}) on texture "${texture.name}"`;
      },
    },
    paintToolDocs[2].status
  );
}

/**
 * Registers `copy_brush_tool` (`paintToolDocs[4]`): records a clone source,
 * then stamps it at the target as one native stroke.
 */
export function registerCopyBrushTool(): void {
  createTool(
    paintToolDocs[4].name,
    {
      ...paintToolDocs[4],
      parameters: copyBrushToolParameters,
      async execute({ texture_id, source, target, brush_size, opacity, mode }) {
        const texture = getAndActivateTexture(texture_id);

        // Apply settings
        applyToolbarValues({ slider_brush_size: brush_size, slider_brush_opacity: opacity, copy_brush_mode: mode });

        // Select copy brush tool
        // @ts-ignore
        BarItems.copy_brush.select();

        // Set source point (Ctrl+click equivalent)
        setCopyBrushSource(texture, source.x, source.y);

        // Apply at target point
        nativePaintStroke(painter => startTextureStroke(painter, texture, target.x, target.y));
        Canvas.updateAll();

        return `Copied from (${source.x}, ${source.y}) to (${target.x}, ${target.y}) on texture "${texture.name}"`;
      },
    },
    paintToolDocs[4].status
  );
}

/**
 * Registers `eraser_tool` (`paintToolDocs[5]`). Connected coordinates form one
 * dragged stroke (one undo entry); disconnected points are erased as separate
 * strokes, each with its own undo entry.
 */
export function registerEraserTool(): void {
  createTool(
    paintToolDocs[5].name,
    {
      ...paintToolDocs[5],
      parameters: eraserToolParameters,
      async execute({ texture_id, coordinates, brush_size, opacity, softness, shape, connect_strokes }) {
        const texture = getAndActivateTexture(texture_id);

        // Apply settings
        applyToolbarValues({
          slider_brush_size: brush_size,
          slider_brush_opacity: opacity,
          slider_brush_softness: softness,
          brush_shape: shape,
        });

        // Select eraser tool
        // @ts-ignore
        BarItems.eraser.select();

        const strokes = connect_strokes ? [coordinates] : coordinates.map(point => [point]);
        strokes.forEach(([first, ...rest]) => nativePaintStroke(
          painter => startTextureStroke(painter, texture, first.x, first.y),
          painter => rest.forEach(point => painter.movePaintTool(texture, point.x, point.y, {}))
        ));
        Canvas.updateAll();

        return `Erased ${coordinates.length} points on texture "${texture.name}"`;
      },
    },
    paintToolDocs[5].status
  );
}
