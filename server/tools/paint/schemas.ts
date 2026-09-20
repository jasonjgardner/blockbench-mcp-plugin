import { z } from "zod";
import {
  textureIdOptionalSchema,
  hexColorSchema,
  opacitySchema,
  brushSizeSchema,
  brushSoftnessSchema,
  brushShapeEnum,
  blendModeEnum,
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
    .describe(
      "Fill mode. 'face' and 'element' fill only the face/element whose UV area contains (x, y) in texture space " +
        "(Blockbench 5.2 looks it up with UVEditor.findFaceAtUV); 'color'/'color_connected' match exact colors; " +
        "'selected_elements' fills every selected element; 'selection' fills the texture selection (image editor)."
    ),
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
 * Brush aspect ratio (Blockbench 5.2 `slider_brush_aspect_ratio`): negative
 * values narrow the width, positive values narrow the height, 0 keeps it even.
 */
export const brushAspectRatioSchema = z
  .number()
  .min(-16)
  .max(16)
  .optional()
  .describe("Brush aspect ratio (-16 to 16). Negative narrows the width, positive narrows the height, 0 keeps the brush square/round.");

/**
 * Input for `copy_brush_tool`: sets a clone source, then stamps it at a target.
 *
 * Shape: `{ texture_id?, source: { x, y }, target: { x, y }, brush_size?, opacity?, mode, aspect_ratio? }`;
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
  aspect_ratio: brushAspectRatioSchema,
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

/** Blockbench 5.2 `brush_lock_mode` options: which faces a viewport stroke may paint. */
export const brushLockModeEnum = z.enum(["none", "element", "selected_faces", "face"]);

/**
 * Input for `paint_settings`: optional paint-mode preferences; omitted fields stay unchanged.
 *
 * Shape: `{ mirror_painting?: { enabled, axis?, texture?, texture_center? }, lock_alpha?, pixel_perfect?, ...,
 * screen_space_brush_projection?, brush_lock_mode?, brush_aspect_ratio? }`.
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
  screen_space_brush_projection: z
    .boolean()
    .optional()
    .describe("Project brushes in screen space when painting in the 3D viewport (Blockbench 5.2+, brush tools only)."),
  brush_lock_mode: brushLockModeEnum
    .optional()
    .describe("Restrict viewport strokes: 'none', the 'element' the stroke started on, 'selected_faces', or the single 'face' it started on (Blockbench 5.2+)."),
  brush_aspect_ratio: brushAspectRatioSchema.describe(
    "Brush aspect ratio (-16 to 16) applied to every tool that supports it (brush and copy brush; Blockbench 5.2+)."
  ),
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
  brush_settings: brushSettingsSchema
    .unwrap()
    .extend({ aspect_ratio: brushAspectRatioSchema })
    .optional()
    .describe("Brush settings to apply. Opacity is 0-255; softness is a 0-100 percentage."),
  connect_strokes: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to interpolate brush samples between coordinates, at no more than one texture pixel per step."),
});

/**
 * Input for `create_brush_preset`: persists a named brush configuration in `StateMemory`.
 *
 * Shape: `{ name, size?, opacity?, softness?, shape?, color?, blend_mode?, pixel_perfect?, screen_space? }`.
 * Omitted values are stored as `null` ("keep the current setting"), matching presets made in Blockbench.
 */
export const createBrushPresetParameters = z.object({
  name: z.string().describe("Name of the brush preset."),
  size: brushSizeSchema,
  opacity: opacitySchema,
  softness: brushSoftnessSchema,
  shape: brushShapeEnum.optional().describe("Brush shape. Omit to keep the current shape when loading."),
  color: hexColorSchema.describe("Brush color as hex string."),
  blend_mode: blendModeEnum.optional().describe("Brush blend mode. Omit to keep the current blend mode when loading."),
  pixel_perfect: z
    .boolean()
    .optional()
    .describe("Enable pixel perfect drawing."),
  screen_space: z
    .boolean()
    .optional()
    .describe("Enable screen-space brush projection when the preset is loaded (Blockbench 5.2+). Omit to keep the current setting."),
});

/**
 * Input for `load_brush_preset`: applies a saved or built-in preset.
 *
 * Shape: `{ preset_name }`. Custom presets match their exact name first; built-in
 * presets (`Painter.default_brush_presets`) match their key, short key, or label.
 */
export const loadBrushPresetParameters = z.object({
  preset_name: z
    .string()
    .describe(
      "Name of the brush preset to load: a custom preset name, or a built-in one such as 'pixel_brush', " +
        "'pixel_perfect', 'smooth_brush' or 'screen_space' (also accepts the full 'menu.brush_presets.*' key or its translated label)."
    ),
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
 * Layer blend modes supported by Blockbench 5.2 (`LayerBlendMode`), plus the
 * legacy alias `"normal"`, which maps to `"default"`.
 */
export const textureLayerBlendModeEnum = z.enum([
  "default",
  "normal",
  "set_opacity",
  "color",
  "multiply",
  "add",
  "darken",
  "lighten",
  "screen",
  "overlay",
  "difference",
  "alpha_mask",
]);

/** Actions accepted by `texture_layer_management`. */
export const textureLayerActionEnum = z.enum([
  "list_layers",
  "select_layer",
  "create_layer",
  "delete_layer",
  "duplicate_layer",
  "merge_down",
  "set_opacity",
  "set_blend_mode",
  "move_layer",
  "rename_layer",
  "flatten_layers",
  "toggle_visibility",
  "create_group",
  "ungroup",
  "move_to_group",
  "set_group_folded",
]);

/**
 * Input for `texture_layer_management`: one layer or layer-group action on a texture.
 *
 * Shape: `{ action, texture_id?, layer_id?, layer_name?, layer_ids?, group_id?, opacity?, blend_mode?, target_index?, folded?, visible? }`.
 * `layer_id` (UUID or exact name) picks the layer or group to act on and falls
 * back to the texture's selected layer. `opacity` is a 0-100 percentage, the
 * unit Blockbench stores on layers. `target_index` is a position among the
 * item's siblings inside the same parent, 0 being the bottom-most.
 */
export const textureLayerManagementParameters = z.object({
  action: textureLayerActionEnum.describe(
    "Layer action. list_layers reports the hierarchy (read-only); select_layer makes a layer the paint target; " +
      "create_group, ungroup, move_to_group and set_group_folded manage layer groups (Blockbench 5.2+); " +
      "toggle_visibility works on layers and groups; flatten_layers composites visible layers into the texture and disables layers."
  ),
  texture_id: textureIdOptionalSchema,
  layer_id: z
    .string()
    .optional()
    .describe("UUID or exact name of the layer or group to act on. Defaults to the texture's selected layer."),
  layer_name: z
    .string()
    .optional()
    .describe("Name for create_layer/create_group/duplicate_layer, or the new name for rename_layer."),
  layer_ids: z
    .array(z.string())
    .optional()
    .describe("create_group: UUIDs or names of layers/groups to move into the new group. They must share the same parent."),
  group_id: z
    .string()
    .optional()
    .describe("UUID or name of the destination group for move_to_group and create_layer. Use an empty string for the root."),
  opacity: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Layer opacity percentage (0-100) for set_opacity."),
  blend_mode: textureLayerBlendModeEnum.optional().describe("Layer blend mode for set_blend_mode ('normal' is an alias of 'default')."),
  target_index: z
    .number()
    .int()
    .optional()
    .describe("move_layer/move_to_group: position among siblings in the same parent, 0 = bottom-most; clamped to the valid range."),
  folded: z.boolean().optional().describe("set_group_folded / create_group: whether the group is collapsed in the layers panel."),
  visible: z
    .boolean()
    .optional()
    .describe("toggle_visibility: explicit visibility to set. Omit to toggle."),
});
