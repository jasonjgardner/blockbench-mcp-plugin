/// <reference types="three" />
/// <reference types="blockbench-types" />
import { createTool } from "@/lib/factories";
import { getAndActivateTexture } from "@/lib/util";
import { paintToolDocs } from "./docs";
import { textureLayerManagementParameters } from "./schemas";

/**
 * Registers `texture_layer_management` (`paintToolDocs[11]`): applies one
 * layer action to a texture inside an undo entry and refreshes the panels.
 */
export function registerTextureLayerManagementTool(): void {
  createTool(
    paintToolDocs[11].name,
    {
      ...paintToolDocs[11],
      parameters: textureLayerManagementParameters,
      async execute({
        action,
        texture_id,
        layer_name,
        opacity,
        blend_mode,
        target_index,
      }) {
        const texture = getAndActivateTexture(texture_id);

        Undo.initEdit({
          textures: [texture],
          layers: texture.layers,
          bitmap: true,
        });

        let result = "";

        switch (action) {
          case "create_layer":
            if (!texture.layers_enabled) {
              texture.activateLayers(true);
            }
            const newLayer = new TextureLayer(
              {
                name: layer_name || `Layer ${texture.layers.length + 1}`,
              },
              texture
            );
            newLayer.setSize(texture.width, texture.height);
            newLayer.addForEditing();
            result = `Created layer "${newLayer.name}"`;
            break;

          case "delete_layer":
            if (!TextureLayer.selected) {
              throw new Error("No layer selected.");
            }
            const layerToDelete = TextureLayer.selected;
            layerToDelete.remove();
            result = `Deleted layer "${layerToDelete.name}"`;
            break;

          case "duplicate_layer":
            if (!TextureLayer.selected) {
              throw new Error("No layer selected.");
            }
            const layerToDuplicate = TextureLayer.selected;
            const duplicatedLayer = layerToDuplicate.duplicate();
            duplicatedLayer.name = `${layerToDuplicate.name} copy`;
            result = `Duplicated layer "${duplicatedLayer.name}"`;
            break;

          case "merge_down":
            if (!TextureLayer.selected) {
              throw new Error("No layer selected.");
            }
            TextureLayer.selected.mergeDown(true);
            result = "Merged layer down";
            break;

          case "set_opacity":
            if (!TextureLayer.selected) {
              throw new Error("No layer selected.");
            }
            if (opacity === undefined) {
              throw new Error("Opacity value required.");
            }
            TextureLayer.selected.opacity = opacity / 100;
            texture.updateChangesAfterEdit();
            result = `Set layer opacity to ${opacity}%`;
            break;

          case "set_blend_mode":
            if (!TextureLayer.selected) {
              throw new Error("No layer selected.");
            }
            if (!blend_mode) {
              throw new Error("Blend mode required.");
            }
            TextureLayer.selected.blend_mode = blend_mode;
            texture.updateChangesAfterEdit();
            result = `Set layer blend mode to ${blend_mode}`;
            break;

          case "move_layer":
            if (!TextureLayer.selected) {
              throw new Error("No layer selected.");
            }
            if (target_index === undefined) {
              throw new Error("Target index required.");
            }
            const layerToMove = TextureLayer.selected;
            texture.layers.remove(layerToMove);
            texture.layers.splice(target_index, 0, layerToMove);
            result = `Moved layer to position ${target_index}`;
            break;

          case "rename_layer":
            if (!TextureLayer.selected) {
              throw new Error("No layer selected.");
            }
            if (!layer_name) {
              throw new Error("New layer name required.");
            }
            const oldName = TextureLayer.selected.name;
            TextureLayer.selected.name = layer_name;
            result = `Renamed layer from "${oldName}" to "${layer_name}"`;
            break;

          case "flatten_layers":
            if (!texture.layers_enabled) {
              throw new Error("Texture has no layers to flatten.");
            }
            texture.flattenLayers();
            result = "Flattened all layers";
            break;
        }

        texture.updateChangesAfterEdit();
        Undo.finishEdit(`Layer management: ${action}`);
        updateInterfacePanels();

        return result;
      },
    },
    paintToolDocs[11].status
  );
}
