import type { IToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";
import {
  paintFillToolParameters,
  drawShapeToolParameters,
  gradientToolParameters,
  colorPickerToolParameters,
  copyBrushToolParameters,
  eraserToolParameters,
  paintSettingsParameters,
  paintWithBrushParameters,
  createBrushPresetParameters,
  loadBrushPresetParameters,
  textureSelectionParameters,
  textureLayerManagementParameters,
} from "./schemas";

/**
 * Public contract for every painting tool, shared by registration and the docs generator.
 *
 * The array order is part of the contract: each register function reads its
 * spec by index (`paintToolDocs[0]` is `paint_fill_tool`, ...,
 * `paintToolDocs[11]` is `texture_layer_management`) and generated docs list
 * tools in this order. Contains no Blockbench globals so it can be imported
 * outside the Blockbench runtime.
 */
export const paintToolDocs: IToolSpec[] = [
  {
    name: "paint_fill_tool",
    condition: { project: true, features: ["paint_mode"], method: () => Texture.all.length > 0 && Boolean(BarItems.fill_tool) && Condition(BarItems.fill_tool.condition) },
    description:
      "Uses the fill/bucket tool to fill areas with color. In 'face' and 'element' fill modes only the face or element whose UV area contains the given texture pixel is filled. Opacity is 0-255 regardless of Blockbench's opacity range setting.",
    annotations: {
      title: "Paint Fill Tool",
      destructiveHint: true,
    },
    parameters: paintFillToolParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "draw_shape_tool",
    condition: { project: true, features: ["paint_mode"], method: () => Texture.all.length > 0 && Boolean(BarItems.draw_shape_tool) && Condition(BarItems.draw_shape_tool.condition) },
    description: "Draws geometric shapes on textures.",
    annotations: {
      title: "Draw Shape Tool",
      destructiveHint: true,
    },
    parameters: drawShapeToolParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "gradient_tool",
    condition: { project: true, features: ["paint_mode"], method: () => Texture.all.length > 0 && Boolean(BarItems.gradient_tool) && Condition(BarItems.gradient_tool.condition) },
    description: "Applies gradients to textures.",
    annotations: {
      title: "Gradient Tool",
      destructiveHint: true,
    },
    parameters: gradientToolParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "color_picker_tool",
    condition: { project: true, features: ["paint_mode"], method: () => Texture.all.length > 0 },
    description:
      "Picks colors from textures and sets them as the active color.",
    annotations: {
      title: "Color Picker Tool",
      readOnlyHint: true,
    },
    parameters: colorPickerToolParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "copy_brush_tool",
    condition: { project: true, features: ["paint_mode"], method: () => Texture.all.length > 0 && Boolean(BarItems.copy_brush) && Condition(BarItems.copy_brush.condition) },
    description: "Uses the copy/clone brush to copy texture areas.",
    annotations: {
      title: "Copy Brush Tool",
      destructiveHint: true,
    },
    parameters: copyBrushToolParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "eraser_tool",
    condition: { project: true, features: ["paint_mode"], method: () => Texture.all.length > 0 && Boolean(BarItems.eraser) && Condition(BarItems.eraser.condition) },
    description: "Erases parts of textures with customizable settings.",
    annotations: {
      title: "Eraser Tool",
      destructiveHint: true,
    },
    parameters: eraserToolParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "paint_settings",
    condition: { project: true, features: ["paint_mode"] },
    description:
      "Configures paint mode settings and preferences, including Blockbench 5.2 screen-space brush projection, brush lock mode and brush aspect ratio. The result also reports the active opacity range (0-255 or 0-100); tool opacity parameters stay 0-255 and are converted automatically.",
    annotations: {
      title: "Paint Settings",
      destructiveHint: true,
    },
    parameters: paintSettingsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "paint_with_brush",
    condition: { project: true, features: ["paint_mode"], method: () => Texture.all.length > 0 },
    description:
      "Paints on textures using the brush tool with customizable settings (opacity 0-255, softness 0-100%, optional aspect ratio). Paints on the selected pixel layer; if a layer group is selected, a pixel layer inside it is used.",
    annotations: {
      title: "Paint with Brush",
      destructiveHint: true,
    },
    parameters: paintWithBrushParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "create_brush_preset",
    description: "Creates a custom brush preset with specified settings. Omitted settings are stored as unset so loading the preset keeps the current value.",
    annotations: {
      title: "Create Brush Preset",
      destructiveHint: true,
    },
    parameters: createBrushPresetParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "load_brush_preset",
    condition: { project: true, features: ["paint_mode"] },
    description: "Loads and applies a custom or built-in brush preset (e.g. 'screen_space') by name.",
    annotations: {
      title: "Load Brush Preset",
      destructiveHint: true,
    },
    parameters: loadBrushPresetParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "texture_selection",
    condition: { project: true, features: ["paint_mode"], method: () => Texture.all.length > 0 },
    description:
      "Creates, modifies, or manipulates texture selections for painting.",
    annotations: {
      title: "Texture Selection",
      destructiveHint: true,
    },
    parameters: textureSelectionParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "texture_layer_management",
    condition: { project: true, features: ["paint_mode"], method: () => Texture.all.length > 0 },
    description:
      "Lists, creates, manages, and reorders texture layers and layer groups (Blockbench 5.2 hierarchy). Target a layer or group by UUID or name with layer_id; list_layers reports type, parent and depth.",
    annotations: {
      title: "Texture Layer Management",
      destructiveHint: true,
    },
    parameters: textureLayerManagementParameters,
    status: STATUS_EXPERIMENTAL,
  },
];
