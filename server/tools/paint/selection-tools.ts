/// <reference types="three" />
/// <reference types="blockbench-types" />
import { createTool } from "@/lib/factories";
import { getAndActivateTexture } from "@/lib/util";
import { paintToolDocs } from "./docs";
import { textureSelectionParameters } from "./schemas";

/**
 * Registers `texture_selection` (`paintToolDocs[10]`): applies one selection
 * action to a texture's pixel selection inside an undo entry.
 */
export function registerTextureSelectionTool(): void {
  createTool(
    paintToolDocs[10].name,
    {
      ...paintToolDocs[10],
      parameters: textureSelectionParameters,
      async execute({ action, texture_id, coordinates, radius, mode }) {
        const texture = getAndActivateTexture(texture_id);

        Undo.initEdit({
          textures: [texture],
          bitmap: true,
        });

        const selection = texture.selection;

        switch (action) {
          case "select_rectangle":
            if (!coordinates) {
              throw new Error("Coordinates required for rectangle selection.");
            }
            selection.clear();
            selection.start_x = coordinates.x1;
            selection.start_y = coordinates.y1;
            selection.end_x = coordinates.x2;
            selection.end_y = coordinates.y2;
            selection.is_custom = false;
            break;

          case "select_ellipse":
            if (!coordinates) {
              throw new Error("Coordinates required for ellipse selection.");
            }
            selection.clear();
            // Create elliptical selection
            selection.is_custom = true;
            const centerX = (coordinates.x1 + coordinates.x2) / 2;
            const centerY = (coordinates.y1 + coordinates.y2) / 2;
            const radiusX = Math.abs(coordinates.x2 - coordinates.x1) / 2;
            const radiusY = Math.abs(coordinates.y2 - coordinates.y1) / 2;

            for (
              let x = Math.floor(centerX - radiusX);
              x <= Math.ceil(centerX + radiusX);
              x++
            ) {
              for (
                let y = Math.floor(centerY - radiusY);
                y <= Math.ceil(centerY + radiusY);
                y++
              ) {
                const dx = (x - centerX) / radiusX;
                const dy = (y - centerY) / radiusY;
                if (dx * dx + dy * dy <= 1) {
                  selection.set(x, y, true);
                }
              }
            }
            break;

          case "select_all":
            // `selection.selectAll()` doesn't exist on current Blockbench
            // (`H.selectAll is not a function`). Emulate via a full-texture
            // rectangular selection instead, matching what the UI does.
            selection.clear();
            selection.start_x = 0;
            selection.start_y = 0;
            selection.end_x = texture.width;
            selection.end_y = texture.height;
            selection.is_custom = false;
            break;

          case "clear_selection":
            selection.clear();
            break;

          case "invert_selection":
            selection.invert();
            break;

          case "expand_selection":
            if (radius === undefined) {
              throw new Error("Radius required for expand selection.");
            }
            selection.expand(radius);
            break;

          case "contract_selection":
            if (radius === undefined) {
              throw new Error("Radius required for contract selection.");
            }
            selection.contract(radius);
            break;

          case "feather_selection":
            if (radius === undefined) {
              throw new Error("Radius required for feather selection.");
            }
            selection.feather(radius);
            break;
        }

        // Update UI
        UVEditor.vue.updateTexture();

        Undo.finishEdit("Texture selection");

        return `Applied ${action} to texture "${texture.name}"`;
      },
    },
    paintToolDocs[10].status
  );
}
