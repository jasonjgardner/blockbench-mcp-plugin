import { z } from "zod";
import {
  textureIdOptionalSchema,
  hexColorSchema,
  opacitySchema,
  brushSizeSchema,
  brushSoftnessSchema,
  brushShapeEnum,
  blendModeEnum,
  layerBlendModeEnum,
  fillModeEnum,
  drawShapeEnum,
  copyBrushModeEnum,
  brushModifierEnum,
  axisEnum,
  coordinateSchema,
  brushSettingsSchema,
} from "@/lib/zodObjects";

/**
 * Input for `paint_fill_tool`: a bucket fill seeded at one texture pixel.
 *
 * Kept free of Blockbench globals so the docs generator can import it. The
 * `tolerance` field stays in the public schema for compatibility, but the
 * native fill API only matches exact colors, so the tool rejects nonzero values
 * at runtime.
 *
 * Shape: `{ texture_id?, x, y, color?, opacity?, tolerance?, fill_mode, blend_mode? }`
 * where `x`/`y` are texture-pixel coordinates and `fill_mode` defaults to
 * `"color_connected"`.
 */
export const paintFillToolParameters = z.object({
  texture_id: textureIdOptionalSchema,
  x: z.number().describe("X coordinate to start fill."),
  y: z.number().describe("Y coordinate to start fill."),
  color: hexColorSchema.describe("Fill color as hex string."),
  opacity: opacitySchema.describe("Fill opacity (0-255)."),
  tolerance: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Only zero (exact color matching) is supported by the native fill API. Nonzero tolerance is rejected."),
  fill_mode: fillModeEnum
    .optional()
    .default("color_connected")
    .describe("Fill mode."),
  blend_mode: blendModeEnum.optional().describe("Fill blend mode."),
});

/**
 * Input for `draw_shape_tool`: one native shape stroke dragged from `start` to `end`.
 *
 * Shape: `{ texture_id?, shape, start: { x, y }, end: { x, y }, color?, line_width?, opacity?, blend_mode? }`;
 * `line_width` (1-50) only affects hollow (`_h`) shapes.
 */
export const drawShapeToolParameters = z.object({
  texture_id: textureIdOptionalSchema,
  shape: drawShapeEnum.describe("Shape to draw. '_h' suffix means hollow."),
  start: coordinateSchema.extend({
    x: z.number().describe("Start X coordinate."),
    y: z.number().describe("Start Y coordinate."),
  }),
  end: coordinateSchema.extend({
    x: z.number().describe("End X coordinate."),
    y: z.number().describe("End Y coordinate."),
  }),
  color: hexColorSchema.describe("Shape color as hex string."),
  line_width: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe("Line width for hollow shapes."),
  opacity: opacitySchema.describe("Shape opacity (0-255)."),
  blend_mode: blendModeEnum.optional().describe("Shape blend mode."),
});

/**
 * Input for `gradient_tool`: a native gradient stroke between two texture points.
 *
 * Shape: `{ texture_id?, start: { x, y }, end: { x, y }, start_color, end_color, opacity?, blend_mode? }`;
 * the colors become Blockbench's primary and secondary colors.
 */
export const gradientToolParameters = z.object({
  texture_id: textureIdOptionalSchema,
  start: coordinateSchema.extend({
    x: z.number().describe("Gradient start X coordinate."),
    y: z.number().describe("Gradient start Y coordinate."),
  }),
  end: coordinateSchema.extend({
    x: z.number().describe("Gradient end X coordinate."),
    y: z.number().describe("Gradient end Y coordinate."),
  }),
  start_color: z.string().describe("Start color as hex string."),
  end_color: z.string().describe("End color as hex string."),
  opacity: opacitySchema.describe("Gradient opacity (0-255)."),
  blend_mode: blendModeEnum.optional().describe("Gradient blend mode."),
});

/**
 * Input for `color_picker_tool`: samples one texture pixel into the color panel.
 *
 * Shape: `{ texture_id?, x, y, set_as_secondary, pick_opacity }`; both flags
 * default to `false`.
 */
export const colorPickerToolParameters = z.object({
  texture_id: textureIdOptionalSchema,
  x: z.number().describe("X coordinate to pick color from."),
  y: z.number().describe("Y coordinate to pick color from."),
  set_as_secondary: z
    .boolean()
    .optional()
    .default(false)
    .describe("Set as secondary color instead of primary."),
  pick_opacity: z
    .boolean()
    .optional()
    .default(false)
    .describe("Also pick and apply the pixel's opacity."),
});

/**
 * Input for `copy_brush_tool`: sets a clone source, then stamps it at a target.
 *
 * Shape: `{ texture_id?, source: { x, y }, target: { x, y }, brush_size?, opacity?, mode }`;
 * `mode` defaults to `"copy"`.
 */
export const copyBrushToolParameters = z.object({
  texture_id: textureIdOptionalSchema,
  source: coordinateSchema.extend({
    x: z.number().describe("Source X coordinate to copy from."),
    y: z.number().describe("Source Y coordinate to copy from."),
  }),
  target: coordinateSchema.extend({
    x: z.number().describe("Target X coordinate to paste to."),
    y: z.number().describe("Target Y coordinate to paste to."),
  }),
  brush_size: brushSizeSchema.describe("Copy brush size."),
  opacity: opacitySchema.describe("Copy opacity (0-255)."),
  mode: copyBrushModeEnum.optional().default("copy").describe("Copy brush mode."),
});

/**
 * Input for `eraser_tool`: one or more native eraser strokes over texture points.
 *
 * Shape: `{ texture_id?, coordinates: [{ x, y }, ...], brush_size?, opacity?, softness?, shape?, connect_strokes }`.
 * At least one coordinate is required so a stroke always has a start point.
 * `connect_strokes` (default `true`) drags one stroke through every point;
 * `false` erases each point as its own stroke and undo entry.
 */
export const eraserToolParameters = z.object({
  texture_id: textureIdOptionalSchema,
  coordinates: z
    .array(
      coordinateSchema.extend({
        x: z.number().describe("X coordinate to erase at."),
        y: z.number().describe("Y coordinate to erase at."),
      })
    )
    .min(1)
    .describe("Array of coordinates to erase at."),
  brush_size: brushSizeSchema.describe("Eraser brush size."),
  opacity: opacitySchema.describe("Eraser opacity (0-255)."),
  softness: brushSoftnessSchema.describe("Eraser softness percentage."),
  shape: brushShapeEnum.optional().describe("Eraser shape."),
  connect_strokes: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to connect erase strokes with lines. Disconnected points are separate native strokes and separate undo entries."),
});

/**
 * Input for `paint_settings`: optional paint-mode preferences; omitted fields stay unchanged.
 *
 * Shape: `{ mirror_painting?: { enabled, axis?, texture?, texture_center? }, lock_alpha?, pixel_perfect?, ... }`.
 */
export const paintSettingsParameters = z.object({
  mirror_painting: z
    .object({
      enabled: z.boolean().describe("Enable mirror painting."),
      axis: z.array(axisEnum).optional().describe("Mirror axes."),
      texture: z.boolean().optional().describe("Enable texture mirroring."),
      texture_center: coordinateSchema
        .extend({
          x: z.number().describe("X coordinate of texture mirror center."),
          y: z.number().describe("Y coordinate of texture mirror center."),
        })
        .optional()
        .describe("Texture mirror center."),
    })
    .optional()
    .describe("Mirror painting settings."),
  lock_alpha: z
    .boolean()
    .optional()
    .describe("Lock alpha channel while painting."),
  pixel_perfect: z
    .boolean()
    .optional()
    .describe("Enable pixel perfect drawing."),
  paint_side_restrict: z
    .boolean()
    .optional()
    .describe("Restrict painting to current face side."),
  color_erase_mode: z
    .boolean()
    .optional()
    .describe("Enable color erase mode."),
  brush_opacity_modifier: brushModifierEnum
    .optional()
    .describe("Brush opacity modifier for stylus."),
  brush_size_modifier: brushModifierEnum
    .optional()
    .describe("Brush size modifier for stylus."),
  paint_with_stylus_only: z
    .boolean()
    .optional()
    .describe("Only allow painting with stylus input."),
  pick_color_opacity: z
    .boolean()
    .optional()
    .describe("Pick opacity when using color picker."),
  pick_combined_color: z
    .boolean()
    .optional()
    .describe("Pick combined layer colors."),
});

/**
 * Input for `paint_with_brush`: stamps brush samples inside one `Texture.edit` transaction.
 *
 * Shape: `{ texture_id?, coordinates: [{ x, y }, ...], brush_settings?, connect_strokes }`.
 * At least one coordinate is required. `connect_strokes` (default `true`)
 * interpolates samples no more than one texture pixel apart between
 * consecutive coordinates; `false` stamps only the given points.
 */
export const paintWithBrushParameters = z.object({
  texture_id: textureIdOptionalSchema,
  coordinates: z
    .array(
      coordinateSchema.extend({
        x: z.number().describe("X coordinate on texture."),
        y: z.number().describe("Y coordinate on texture."),
      })
    )
    .min(1)
    .describe("Array of coordinates to paint at."),
  brush_settings: brushSettingsSchema,
  connect_strokes: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to interpolate brush samples between coordinates, at no more than one texture pixel per step."),
});

/**
 * Input for `create_brush_preset`: persists a named brush configuration in `StateMemory`.
 *
 * Shape: `{ name, size?, opacity?, softness?, shape?, color?, blend_mode?, pixel_perfect? }`.
 */
export const createBrushPresetParameters = z.object({
  name: z.string().describe("Name of the brush preset."),
  size: brushSizeSchema,
  opacity: opacitySchema,
  softness: brushSoftnessSchema,
  shape: brushShapeEnum.optional().describe("Brush shape."),
  color: hexColorSchema.describe("Brush color as hex string."),
  blend_mode: blendModeEnum.optional().describe("Brush blend mode."),
  pixel_perfect: z
    .boolean()
    .optional()
    .describe("Enable pixel perfect drawing."),
});

/**
 * Input for `load_brush_preset`: applies a previously saved preset.
 *
 * Shape: `{ preset_name }`, matched exactly against stored preset names.
 */
export const loadBrushPresetParameters = z.object({
  preset_name: z.string().describe("Name of the brush preset to load."),
});

/**
 * Input for `texture_selection`: one selection action on a texture's pixel selection mask.
 *
 * Shape: `{ action, texture_id?, coordinates?: { x1, y1, x2, y2 }, radius?, mode }`;
 * rectangle/ellipse actions need `coordinates`, expand/contract/feather need `radius`.
 */
export const textureSelectionParameters = z.object({
  action: z
    .enum([
      "select_rectangle",
      "select_ellipse",
      "select_all",
      "clear_selection",
      "invert_selection",
      "expand_selection",
      "contract_selection",
      "feather_selection",
    ])
    .describe("Selection action to perform."),
  texture_id: textureIdOptionalSchema,
  coordinates: z
    .object({
      x1: z.number().describe("Start X coordinate."),
      y1: z.number().describe("Start Y coordinate."),
      x2: z.number().describe("End X coordinate."),
      y2: z.number().describe("End Y coordinate."),
    })
    .optional()
    .describe("Selection area coordinates."),
  radius: z
    .number()
    .optional()
    .describe("Radius for expand/contract/feather operations."),
  mode: z
    .enum(["create", "add", "subtract", "intersect"])
    .optional()
    .default("create")
    .describe("Selection mode."),
});

/**
 * Input for `texture_layer_management`: one layer action on a texture.
 *
 * Shape: `{ action, texture_id?, layer_name?, opacity?, blend_mode?, target_index? }`;
 * `opacity` is a 0-100 percentage and most actions operate on the selected layer.
 */
export const textureLayerManagementParameters = z.object({
  action: z
    .enum([
      "create_layer",
      "delete_layer",
      "duplicate_layer",
      "merge_down",
      "set_opacity",
      "set_blend_mode",
      "move_layer",
      "rename_layer",
      "flatten_layers",
    ])
    .describe("Layer management action."),
  texture_id: textureIdOptionalSchema,
  layer_name: z.string().optional().describe("Name of the layer."),
  opacity: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Layer opacity percentage."),
  blend_mode: layerBlendModeEnum.optional().describe("Layer blend mode."),
  target_index: z
    .number()
    .optional()
    .describe("Target position for moving layers."),
});
