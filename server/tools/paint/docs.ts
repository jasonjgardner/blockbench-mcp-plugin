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
    description: "Uses the fill/bucket tool to fill areas with color.",
    annotations: {
      title: "Paint Fill Tool",
      destructiveHint: true,
    },
    parameters: paintFillToolParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "draw_shape_tool",
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
    description: "Configures paint mode settings and preferences.",
    annotations: {
      title: "Paint Settings",
      destructiveHint: true,
    },
    parameters: paintSettingsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "paint_with_brush",
    description:
      "Paints on textures using the brush tool with customizable settings.",
    annotations: {
      title: "Paint with Brush",
      destructiveHint: true,
    },
    parameters: paintWithBrushParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "create_brush_preset",
    description: "Creates a custom brush preset with specified settings.",
    annotations: {
      title: "Create Brush Preset",
      destructiveHint: true,
    },
    parameters: createBrushPresetParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "load_brush_preset",
    description: "Loads and applies a brush preset by name.",
    annotations: {
      title: "Load Brush Preset",
      destructiveHint: true,
    },
    parameters: loadBrushPresetParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "texture_selection",
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
    description: "Creates, manages, and manipulates texture layers.",
    annotations: {
      title: "Texture Layer Management",
      destructiveHint: true,
    },
    parameters: textureLayerManagementParameters,
    status: STATUS_EXPERIMENTAL,
  },
];
