/// <reference types="three" />
/// <reference types="blockbench-types" />
import { createTool } from "@/lib/factories";
import { getAndActivateTexture, setBarItemValue } from "@/lib/util";
import { paintToolDocs } from "./docs";
import { colorPickerToolParameters, paintSettingsParameters } from "./schemas";

/**
 * Registers `color_picker_tool` (`paintToolDocs[3]`): samples a texture pixel
 * into the color panel and optionally copies its alpha to brush opacity.
 */
export function registerColorPickerTool(): void {
  createTool(
    paintToolDocs[3].name,
    {
      ...paintToolDocs[3],
      parameters: colorPickerToolParameters,
      async execute({ texture_id, x, y, set_as_secondary, pick_opacity }) {
        const texture = getAndActivateTexture(texture_id);

        // Pick color
        Painter.colorPicker(texture, x, y, { button: set_as_secondary ? 2 : 0 });

        // Get the picked color
        const color = ColorPanel.get();

        if (pick_opacity) {
          // Get pixel color with alpha
          const pixelColor = Painter.getPixelColor(texture.ctx, x, y);
          const opacity = Math.floor(pixelColor.getAlpha() * 255);

          // Apply opacity to brush tools
          for (let id in BarItems) {
            const tool = BarItems[id];
            // @ts-ignore
            if (tool.tool_settings && tool.tool_settings.brush_opacity >= 0) {
              // @ts-ignore
              tool.tool_settings.brush_opacity = opacity;
            }
          }

          return `Picked color ${color} with opacity ${opacity} from (${x}, ${y}) on texture "${texture.name}"`;
        }

        return `Picked color ${color} from (${x}, ${y}) on texture "${texture.name}"`;
      },
    },
    paintToolDocs[3].status
  );
}

/**
 * Registers `paint_settings` (`paintToolDocs[6]`): toggles paint-mode
 * preferences, reporting each changed setting in the result text.
 */
export function registerPaintSettingsTool(): void {
  createTool(
    paintToolDocs[6].name,
    {
      ...paintToolDocs[6],
      parameters: paintSettingsParameters,
      async execute({
        mirror_painting,
        lock_alpha,
        pixel_perfect,
        paint_side_restrict,
        color_erase_mode,
        brush_opacity_modifier,
        brush_size_modifier,
        paint_with_stylus_only,
        pick_color_opacity,
        pick_combined_color,
      }) {
        const settings: string[] = [];

        // Mirror painting
        if (mirror_painting !== undefined) {
          setBarItemValue("mirror_painting", mirror_painting.enabled);
          Painter.mirror_painting = mirror_painting.enabled;
          settings.push(`Mirror painting: ${mirror_painting.enabled}`);

          if (
            mirror_painting.enabled &&
            (mirror_painting.axis ||
              mirror_painting.texture ||
              mirror_painting.texture_center)
          ) {
            // @ts-ignore
            const options = Painter.mirror_painting_options;
            if (mirror_painting.axis) {
              mirror_painting.axis.forEach((axis) => {
                options[axis] = true;
              });
            }
            if (mirror_painting.texture !== undefined) {
              options.texture = mirror_painting.texture;
            }
            if (mirror_painting.texture_center) {
              options.texture_center = [
                mirror_painting.texture_center.x,
                mirror_painting.texture_center.y,
              ];
            }
            settings.push(`Mirror options updated`);
          }
        }

        // Lock alpha
        if (lock_alpha !== undefined) {
          Painter.lock_alpha = lock_alpha;
          settings.push(`Lock alpha: ${lock_alpha}`);
        }

        // Pixel perfect
        if (pixel_perfect !== undefined) {
          setBarItemValue("pixel_perfect_drawing", pixel_perfect);
          settings.push(`Pixel perfect: ${pixel_perfect}`);
        }

        // Color erase mode
        if (color_erase_mode !== undefined) {
          setBarItemValue("color_erase_mode", color_erase_mode);
          Painter.erase_mode = color_erase_mode;
          settings.push(`Color erase mode: ${color_erase_mode}`);
        }

        // Settings that require accessing the settings object
        if (paint_side_restrict !== undefined) {
          // @ts-ignore
          settings.paint_side_restrict.value = paint_side_restrict;
          settings.push(`Paint side restrict: ${paint_side_restrict}`);
        }

        if (brush_opacity_modifier !== undefined) {
          // @ts-ignore
          settings.brush_opacity_modifier.value = brush_opacity_modifier;
          settings.push(`Brush opacity modifier: ${brush_opacity_modifier}`);
        }

        if (brush_size_modifier !== undefined) {
          // @ts-ignore
          settings.brush_size_modifier.value = brush_size_modifier;
          settings.push(`Brush size modifier: ${brush_size_modifier}`);
        }

        if (paint_with_stylus_only !== undefined) {
          // @ts-ignore
          settings.paint_with_stylus_only.value = paint_with_stylus_only;
          settings.push(`Paint with stylus only: ${paint_with_stylus_only}`);
        }

        if (pick_color_opacity !== undefined) {
          // @ts-ignore
          settings.pick_color_opacity.value = pick_color_opacity;
          settings.push(`Pick color opacity: ${pick_color_opacity}`);
        }

        if (pick_combined_color !== undefined) {
          // @ts-ignore
          settings.pick_combined_color.value = pick_combined_color;
          settings.push(`Pick combined color: ${pick_combined_color}`);
        }

        return `Updated paint settings: ${settings.join(", ")}`;
      },
    },
    paintToolDocs[6].status
  );
}
