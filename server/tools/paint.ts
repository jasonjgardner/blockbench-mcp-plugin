/// <reference types="three" />
/// <reference types="blockbench-types" />
import {
  registerPaintFillTool,
  registerDrawShapeTool,
  registerGradientTool,
  registerCopyBrushTool,
  registerEraserTool,
} from "./paint/stroke-tools";
import { registerColorPickerTool, registerPaintSettingsTool } from "./paint/settings-tools";
import {
  registerPaintWithBrushTool,
  registerCreateBrushPresetTool,
  registerLoadBrushPresetTool,
} from "./paint/brush-tools";
import { registerTextureSelectionTool } from "./paint/selection-tools";
import { registerTextureLayerManagementTool } from "./paint/layer-tools";

export {
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
} from "./paint/schemas";
export { paintToolDocs } from "./paint/docs";

/** Per-tool registrations in `paintToolDocs` order, so tool listings keep their documented order. */
const paintToolRegistrations: ReadonlyArray<() => void> = [
  registerPaintFillTool,
  registerDrawShapeTool,
  registerGradientTool,
  registerColorPickerTool,
  registerCopyBrushTool,
  registerEraserTool,
  registerPaintSettingsTool,
  registerPaintWithBrushTool,
  registerCreateBrushPresetTool,
  registerLoadBrushPresetTool,
  registerTextureSelectionTool,
  registerTextureLayerManagementTool,
];

/**
 * Registers every painting tool with the MCP server.
 *
 * Native Painter strokes and `Texture.edit` own their undo transactions.
 * Registration only builds tool definitions; Blockbench globals are read when a
 * tool executes, so this is safe to call before the Blockbench UI is ready.
 *
 * @throws Error when a paint tool name is already registered.
 */
export function registerPaintTools(): void {
  paintToolRegistrations.forEach(register => register());
}
