/// <reference types="three" />
/// <reference types="blockbench-types" />
import { createTool } from "@/lib/factories";
import { getAndActivateTexture, getProjectTexture, setBarItemValue } from "@/lib/util";
import { paintToolDocs } from "./docs";
import {
  paintFillToolParameters,
  drawShapeToolParameters,
  gradientToolParameters,
  copyBrushToolParameters,
  eraserToolParameters,
} from "./schemas";
import { nativePaintStroke, setCopyBrushSource, startTextureStroke } from "./native-painter";
import { applyToolbarValues, brushOpacityForToolbar, ensurePaintableLayer } from "./runtime";

/** Fill modes seeded at (x, y); selection and selected_elements fills ignore the coordinate. */
const SEEDED_FILL_MODES: ReadonlySet<string> = new Set(["color", "color_connected", "face", "element"]);

/** The texture a paint tool would activate, resolved like `getAndActivateTexture` but without selecting it. */
function peekPaintTexture(textureId: string | undefined): Texture | undefined {
  return (textureId ? getProjectTexture(textureId) : Texture.selected ?? Texture.getDefault()) ?? undefined;
}

/**
 * Rejects fill seeds the native fill would misread, before anything changes.
 * Outside the texture, a color fill matches every transparent pixel and a
 * connected fill finds nothing. Face and element fills look the face up with
 * `UVEditor.findFaceAtUV`, exactly as `Painter.useFilltool` does; when no face
 * is hit, Blockbench fills the whole texture (or its selection) instead.
 */
function assertFillSeed(texture: Texture, x: number, y: number, fillMode: string): void {
  if (!SEEDED_FILL_MODES.has(fillMode)) return;
  if (x < 0 || y < 0 || x >= texture.width || y >= texture.height) {
    throw new Error(`Fill seed (${x}, ${y}) lies outside texture "${texture.name}" (${texture.width}x${texture.height} pixels).`);
  }
  if (fillMode !== "face" && fillMode !== "element") return;
  const findFaceAtUV: unknown = Reflect.get(UVEditor, "findFaceAtUV");
  if (typeof findFaceAtUV !== "function") {
    throw new Error(`fill_mode "${fillMode}" needs Blockbench 5.2 or newer, which can find the face at a texture pixel; this version would fill the whole texture.`);
  }
  const hit: unknown = findFaceAtUV.call(UVEditor, texture, x, y, texture.width / texture.getUVWidth(), texture.display_height / texture.getUVHeight());
  if (!hit) {
    throw new Error(`No face textured with "${texture.name}" covers pixel (${x}, ${y}), so a ${fillMode} fill has nothing to fill. Pick a pixel inside a face's UV area.`);
  }
}

/**
 * Color fills read the seed color from the active layer's canvas at the seed
 * minus the layer offset (`Painter.useFilltool`). On a layer smaller than the
 * texture, or offset from it, a seed outside the layer reads transparent, so a
 * color fill would recolor every transparent pixel of the layer. Checked on the
 * layer that will actually be painted, after `ensurePaintableLayer`.
 */
function assertSeedOnActiveLayer(texture: Texture, x: number, y: number, fillMode: string): void {
  if (fillMode !== "color" && fillMode !== "color_connected") return;
  if (!texture.layers_enabled) return;
  const layer = texture.getActiveLayer();
  if (!layer) return;
  const [left, top] = layer.offset;
  if (x < left || y < top || x >= left + layer.width || y >= top + layer.height) {
    throw new Error(`Fill seed (${x}, ${y}) lies outside the active layer "${layer.name}" (${layer.width}x${layer.height} pixels at ${left}, ${top}), where a ${fillMode} fill reads its seed color. Select a layer that covers the pixel, or pick a pixel on this one.`);
  }
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
        const target = peekPaintTexture(texture_id);
        if (target) assertFillSeed(target, x, y, fill_mode);
        const texture = getAndActivateTexture(texture_id);
        ensurePaintableLayer(texture);
        assertSeedOnActiveLayer(texture, x, y, fill_mode);

        // Select the tool first: slider values are stored per tool.
        // @ts-ignore
        BarItems.fill_tool.select();
        if (color) {
          ColorPanel.set(color);
        }
        applyToolbarValues({ slider_brush_opacity: brushOpacityForToolbar(opacity), fill_mode, blend_mode });

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
        ensurePaintableLayer(texture);

        // Select the tool first: slider values are stored per tool.
        // @ts-ignore
        BarItems.draw_shape_tool.select();
        if (color) {
          ColorPanel.set(color);
        }
        applyToolbarValues({ slider_brush_opacity: brushOpacityForToolbar(opacity), slider_brush_size: line_width, blend_mode });
        setBarItemValue("draw_shape_type", shape);

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
        ensurePaintableLayer(texture);

        // Select the tool first: slider values are stored per tool.
        // @ts-ignore
        BarItems.gradient_tool.select();
        ColorPanel.set(start_color);
        // @ts-ignore
        ColorPanel.set(end_color, true); // Set as secondary color
        applyToolbarValues({ slider_brush_opacity: brushOpacityForToolbar(opacity), blend_mode });

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
      async execute({ texture_id, source, target, brush_size, opacity, mode, aspect_ratio }) {
        const texture = getAndActivateTexture(texture_id);
        ensurePaintableLayer(texture);

        // Select the tool first: slider values are stored per tool.
        // @ts-ignore
        BarItems.copy_brush.select();
        applyToolbarValues({
          slider_brush_size: brush_size,
          slider_brush_opacity: brushOpacityForToolbar(opacity),
          slider_brush_aspect_ratio: aspect_ratio,
          copy_brush_mode: mode,
        });

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
        ensurePaintableLayer(texture);

        // Select the tool first: slider values are stored per tool.
        // @ts-ignore
        BarItems.eraser.select();
        applyToolbarValues({
          slider_brush_size: brush_size,
          slider_brush_opacity: brushOpacityForToolbar(opacity),
          slider_brush_softness: softness,
          brush_shape: shape,
        });

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
