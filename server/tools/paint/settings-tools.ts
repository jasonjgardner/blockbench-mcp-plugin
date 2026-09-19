/// <reference types="three" />
/// <reference types="blockbench-types" />
import { createTool } from "@/lib/factories";
import { getAndActivateTexture, setBarItemValue } from "@/lib/util";
import { paintToolDocs } from "./docs";
import { alphaToOpacity, toOpacityRange } from "./paint-math";
import { colorPickerToolParameters, paintSettingsParameters } from "./schemas";
import {
  activeOpacityRange,
  blockbenchSetting,
  painterRuntime,
  setToolSettingOnAllTools,
} from "./runtime";

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

        painterRuntime().colorPicker(texture, x, y, { button: set_as_secondary ? 2 : 0 });
        const color = ColorPanel.get();

        if (!pick_opacity) {
          return `Picked color ${color} from (${x}, ${y}) on texture "${texture.name}"`;
        }

        // Public API stays 0-255; brush_opacity tool settings use the active range.
        const opacity = alphaToOpacity(Painter.getPixelColor(texture.ctx, x, y).getAlpha());
        setToolSettingOnAllTools(
          "brush_opacity",
          toOpacityRange(opacity, activeOpacityRange()),
          tool => typeof tool.tool_settings.brush_opacity === "number" && tool.tool_settings.brush_opacity >= 0,
          "slider_brush_opacity"
        );

        return `Picked color ${color} with opacity ${opacity} (0-255) from (${x}, ${y}) on texture "${texture.name}"`;
      },
    },
    paintToolDocs[3].status
  );
}

/**
 * Sets a Blockbench setting through `Setting.set` (fires `onChange` and saves),
 * returning a change note, or a note that the setting is unavailable.
 */
function applySetting(id: string, value: boolean | string, label: string): string {
  const setting = blockbenchSetting(id);
  if (!setting) return `${label}: unavailable in this Blockbench version`;
  setting.set(value);
  return `${label}: ${value}`;
}

/** Whether a bar item exists, so version-specific toolbar settings can be reported as unavailable. */
function hasBarItem(id: string): boolean {
  return Boolean((BarItems as unknown as Record<string, unknown>)[id]);
}

/**
 * Sets a toolbar toggle/select, returning a change note, or a note that the
 * item is unavailable (for example on Blockbench versions before 5.2).
 */
function applyBarItem(id: string, value: boolean | string, label: string): string {
  if (!hasBarItem(id)) return `${label}: unavailable in this Blockbench version`;
  setBarItemValue(id, value);
  return `${label}: ${value}`;
}

/**
 * Registers `paint_settings` (`paintToolDocs[6]`): toggles paint-mode
 * preferences, reporting each changed setting and the active opacity range.
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
        screen_space_brush_projection,
        brush_lock_mode,
        brush_aspect_ratio,
      }) {
        const painter = painterRuntime();
        const changes: string[] = [];

        if (mirror_painting !== undefined) {
          setBarItemValue("mirror_painting", mirror_painting.enabled);
          painter.mirror_painting = mirror_painting.enabled;
          changes.push(`Mirror painting: ${mirror_painting.enabled}`);

          const options = painter.mirror_painting_options;
          const hasOptions = Boolean(mirror_painting.axis || mirror_painting.texture !== undefined || mirror_painting.texture_center);
          if (mirror_painting.enabled && hasOptions && options) {
            mirror_painting.axis?.forEach(axis => {
              options[axis] = true;
            });
            if (mirror_painting.texture !== undefined) options.texture = mirror_painting.texture;
            if (mirror_painting.texture_center) {
              options.texture_center = [mirror_painting.texture_center.x, mirror_painting.texture_center.y];
            }
            changes.push("Mirror options updated");
          }
        }

        if (lock_alpha !== undefined) {
          setBarItemValue("lock_alpha", lock_alpha);
          painter.lock_alpha = lock_alpha;
          changes.push(`Lock alpha: ${lock_alpha}`);
        }

        if (pixel_perfect !== undefined) {
          changes.push(applyBarItem("pixel_perfect_drawing", pixel_perfect, "Pixel perfect"));
        }

        if (color_erase_mode !== undefined) {
          setBarItemValue("color_erase_mode", color_erase_mode);
          painter.erase_mode = color_erase_mode;
          changes.push(`Color erase mode: ${color_erase_mode}`);
        }

        const settingChanges: ReadonlyArray<[string, boolean | string | undefined, string]> = [
          ["paint_side_restrict", paint_side_restrict, "Paint side restrict"],
          ["brush_opacity_modifier", brush_opacity_modifier, "Brush opacity modifier"],
          ["brush_size_modifier", brush_size_modifier, "Brush size modifier"],
          ["paint_with_stylus_only", paint_with_stylus_only, "Paint with stylus only"],
          ["pick_color_opacity", pick_color_opacity, "Pick color opacity"],
          ["pick_combined_color", pick_combined_color, "Pick combined color"],
        ];
        settingChanges
          .filter((entry): entry is [string, boolean | string, string] => entry[1] !== undefined)
          .forEach(([id, value, label]) => changes.push(applySetting(id, value, label)));

        if (screen_space_brush_projection !== undefined) {
          changes.push(applyBarItem("screen_space_brush_projection", screen_space_brush_projection, "Screen-space brush projection"));
        }

        if (brush_lock_mode !== undefined) {
          changes.push(applyBarItem("brush_lock_mode", brush_lock_mode, "Brush lock mode"));
        }

        if (brush_aspect_ratio !== undefined) {
          const updated = setToolSettingOnAllTools(
            "brush_aspect_ratio",
            brush_aspect_ratio,
            tool => tool.brush?.aspect_ratio === true,
            "slider_brush_aspect_ratio"
          );
          changes.push(
            updated > 0
              ? `Brush aspect ratio: ${brush_aspect_ratio} (${updated} tools)`
              : "Brush aspect ratio: unavailable in this Blockbench version"
          );
        }

        const range = activeOpacityRange();
        const summary = changes.length > 0 ? changes.join(", ") : "no changes";
        return `Updated paint settings: ${summary}. Opacity range: 0-${range} (tool opacity parameters are always 0-255 and converted automatically).`;
      },
    },
    paintToolDocs[6].status
  );
}
