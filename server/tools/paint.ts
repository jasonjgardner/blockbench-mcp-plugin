/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";

createTool(
    "paint_fill_tool",
    {
      description: "Uses the fill/bucket tool to fill areas with color.",
      annotations: {
        title: "Paint Fill Tool",
        destructiveHint: true,
      },
      parameters: z.object({
        texture_id: z
          .string()
          .optional()
          .describe(
            "Texture ID or name. If not provided, uses selected texture."
          ),
        x: z.number().describe("X coordinate to start fill."),
        y: z.number().describe("Y coordinate to start fill."),
        color: z.string().optional().describe("Fill color as hex string."),
        opacity: z
          .number()
          .min(0)
          .max(255)
          .optional()
          .describe("Fill opacity (0-255)."),
        tolerance: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Color tolerance for fill."),
        fill_mode: z
          .enum([
            "color",
            "color_connected",
            "face",
            "element",
            "selected_elements",
            "selection",
          ])
          .optional()
          .default("color_connected")
          .describe("Fill mode."),
        blend_mode: z
          .enum([
            "default",
            "set_opacity",
            "color",
            "behind",
            "multiply",
            "add",
            "screen",
            "overlay",
            "difference",
          ])
          .optional()
          .describe("Fill blend mode."),
      }),
      async execute({
        texture_id,
        x,
        y,
        color,
        opacity,
        tolerance,
        fill_mode,
        blend_mode,
      }) {
        const texture = texture_id
          ? getProjectTexture(texture_id)
          : Texture.getDefault();
  
        if (!texture) {
          throw new Error(
            texture_id
              ? `Texture with ID "${texture_id}" not found.`
              : "No texture available."
          );
        }
  
        Undo.initEdit({
          textures: [texture],
          bitmap: true,
        });
  
        // Apply settings
        if (color) {
          ColorPanel.set(color);
        }
        if (opacity !== undefined) {
          // @ts-ignore
          BarItems.slider_brush_opacity.set(opacity);
        }
        if (fill_mode) {
          // @ts-ignore
          BarItems.fill_mode.set(fill_mode);
        }
        if (blend_mode) {
          // @ts-ignore
          BarItems.blend_mode.set(blend_mode);
        }
  
        // Select fill tool
        // @ts-ignore
        BarItems.fill_tool.select();
  
        // Perform fill
        Painter.startPaintTool(texture, x, y);
        Painter.stopPaintTool();
  
        Undo.finishEdit("Fill tool");
        Canvas.updateAll();
  
        return `Filled area at (${x}, ${y}) on texture "${texture.name}"`;
      },
    },
    STATUS_EXPERIMENTAL
  );
  
  createTool(
    "draw_shape_tool",
    {
      description: "Draws geometric shapes on textures.",
      annotations: {
        title: "Draw Shape Tool",
        destructiveHint: true,
      },
      parameters: z.object({
        texture_id: z
          .string()
          .optional()
          .describe(
            "Texture ID or name. If not provided, uses selected texture."
          ),
        shape: z
          .enum(["rectangle", "rectangle_h", "ellipse", "ellipse_h"])
          .describe("Shape to draw. '_h' suffix means hollow."),
        start: z.object({
          x: z.number().describe("Start X coordinate."),
          y: z.number().describe("Start Y coordinate."),
        }),
        end: z.object({
          x: z.number().describe("End X coordinate."),
          y: z.number().describe("End Y coordinate."),
        }),
        color: z.string().optional().describe("Shape color as hex string."),
        line_width: z
          .number()
          .min(1)
          .max(50)
          .optional()
          .describe("Line width for hollow shapes."),
        opacity: z
          .number()
          .min(0)
          .max(255)
          .optional()
          .describe("Shape opacity (0-255)."),
        blend_mode: z
          .enum([
            "default",
            "set_opacity",
            "color",
            "behind",
            "multiply",
            "add",
            "screen",
            "overlay",
            "difference",
          ])
          .optional()
          .describe("Shape blend mode."),
      }),
      async execute({
        texture_id,
        shape,
        start,
        end,
        color,
        line_width,
        opacity,
        blend_mode,
      }) {
        const texture = texture_id
          ? getProjectTexture(texture_id)
          : Texture.getDefault();
  
        if (!texture) {
          throw new Error(
            texture_id
              ? `Texture with ID "${texture_id}" not found.`
              : "No texture available."
          );
        }
  
        Undo.initEdit({
          textures: [texture],
          bitmap: true,
        });
  
        // Apply settings
        if (color) {
          ColorPanel.set(color);
        }
        if (opacity !== undefined) {
          // @ts-ignore
          BarItems.slider_brush_opacity.set(opacity);
        }
        if (line_width !== undefined) {
          // @ts-ignore
          BarItems.slider_brush_size.set(line_width);
        }
        if (blend_mode) {
          // @ts-ignore
          BarItems.blend_mode.set(blend_mode);
        }
  
        // Set shape type
        // @ts-ignore
        BarItems.draw_shape_type.set(shape);
  
        // Select draw shape tool
        // @ts-ignore
        BarItems.draw_shape_tool.select();
  
        // Draw shape
        Painter.startPaintTool(texture, start.x, start.y);
        Painter.useShapeTool(texture, end.x, end.y, {});
        Painter.stopPaintTool();
  
        Undo.finishEdit("Draw shape");
        Canvas.updateAll();
  
        return `Drew ${shape} from (${start.x}, ${start.y}) to (${end.x}, ${end.y}) on texture "${texture.name}"`;
      },
    },
    STATUS_EXPERIMENTAL
  );
  
  createTool(
    "gradient_tool",
    {
      description: "Applies gradients to textures.",
      annotations: {
        title: "Gradient Tool",
        destructiveHint: true,
      },
      parameters: z.object({
        texture_id: z
          .string()
          .optional()
          .describe(
            "Texture ID or name. If not provided, uses selected texture."
          ),
        start: z.object({
          x: z.number().describe("Gradient start X coordinate."),
          y: z.number().describe("Gradient start Y coordinate."),
        }),
        end: z.object({
          x: z.number().describe("Gradient end X coordinate."),
          y: z.number().describe("Gradient end Y coordinate."),
        }),
        start_color: z.string().describe("Start color as hex string."),
        end_color: z.string().describe("End color as hex string."),
        opacity: z
          .number()
          .min(0)
          .max(255)
          .optional()
          .describe("Gradient opacity (0-255)."),
        blend_mode: z
          .enum([
            "default",
            "set_opacity",
            "color",
            "behind",
            "multiply",
            "add",
            "screen",
            "overlay",
            "difference",
          ])
          .optional()
          .describe("Gradient blend mode."),
      }),
      async execute({
        texture_id,
        start,
        end,
        start_color,
        end_color,
        opacity,
        blend_mode,
      }) {
        const texture = texture_id
          ? getProjectTexture(texture_id)
          : Texture.getDefault();
  
        if (!texture) {
          throw new Error(
            texture_id
              ? `Texture with ID "${texture_id}" not found.`
              : "No texture available."
          );
        }
  
        Undo.initEdit({
          textures: [texture],
          bitmap: true,
        });
  
        // Apply settings
        ColorPanel.set(start_color);
        // @ts-ignore
        ColorPanel.set(end_color, true); // Set as secondary color
  
        if (opacity !== undefined) {
          // @ts-ignore
          BarItems.slider_brush_opacity.set(opacity);
        }
        if (blend_mode) {
          // @ts-ignore
          BarItems.blend_mode.set(blend_mode);
        }
  
        // Select gradient tool
        // @ts-ignore
        BarItems.gradient_tool.select();
  
        // Apply gradient
        Painter.startPaintTool(texture, start.x, start.y);
        Painter.useGradientTool(texture, end.x, end.y, {});
        Painter.stopPaintTool();
  
        Undo.finishEdit("Apply gradient");
        Canvas.updateAll();
  
        return `Applied gradient from (${start.x}, ${start.y}) to (${end.x}, ${end.y}) on texture "${texture.name}"`;
      },
    },
    STATUS_EXPERIMENTAL
  );
  
  createTool(
    "color_picker_tool",
    {
      description:
        "Picks colors from textures and sets them as the active color.",
      annotations: {
        title: "Color Picker Tool",
        readOnlyHint: true,
      },
      parameters: z.object({
        texture_id: z
          .string()
          .optional()
          .describe(
            "Texture ID or name. If not provided, uses selected texture."
          ),
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
      }),
      async execute({ texture_id, x, y, set_as_secondary, pick_opacity }) {
        const texture = texture_id
          ? getProjectTexture(texture_id)
          : Texture.getDefault();
  
        if (!texture) {
          throw new Error(
            texture_id
              ? `Texture with ID "${texture_id}" not found.`
              : "No texture available."
          );
        }
  
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
    STATUS_EXPERIMENTAL
  );
  
  createTool(
    "copy_brush_tool",
    {
      description: "Uses the copy/clone brush to copy texture areas.",
      annotations: {
        title: "Copy Brush Tool",
        destructiveHint: true,
      },
      parameters: z.object({
        texture_id: z
          .string()
          .optional()
          .describe(
            "Texture ID or name. If not provided, uses selected texture."
          ),
        source: z.object({
          x: z.number().describe("Source X coordinate to copy from."),
          y: z.number().describe("Source Y coordinate to copy from."),
        }),
        target: z.object({
          x: z.number().describe("Target X coordinate to paste to."),
          y: z.number().describe("Target Y coordinate to paste to."),
        }),
        brush_size: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Copy brush size."),
        opacity: z
          .number()
          .min(0)
          .max(255)
          .optional()
          .describe("Copy opacity (0-255)."),
        mode: z
          .enum(["copy", "sample", "pattern"])
          .optional()
          .default("copy")
          .describe("Copy brush mode."),
      }),
      async execute({ texture_id, source, target, brush_size, opacity, mode }) {
        const texture = texture_id
          ? getProjectTexture(texture_id)
          : Texture.getDefault();
  
        if (!texture) {
          throw new Error(
            texture_id
              ? `Texture with ID "${texture_id}" not found.`
              : "No texture available."
          );
        }
  
        Undo.initEdit({
          textures: [texture],
          bitmap: true,
        });
  
        // Apply settings
        if (brush_size !== undefined) {
          // @ts-ignore
          BarItems.slider_brush_size.set(brush_size);
        }
        if (opacity !== undefined) {
          // @ts-ignore
          BarItems.slider_brush_opacity.set(opacity);
        }
        if (mode) {
          // @ts-ignore
          BarItems.copy_brush_mode.set(mode);
        }
  
        // Select copy brush tool
        // @ts-ignore
        BarItems.copy_brush.select();
  
        // Set source point (Ctrl+click equivalent)
        Painter.startPaintTool(texture, source.x, source.y, undefined, {
          ctrlOrCmd: true,
        });
  
        // Apply at target point
        Painter.startPaintTool(texture, target.x, target.y);
        Painter.stopPaintTool();
  
        Undo.finishEdit("Copy brush");
        Canvas.updateAll();
  
        return `Copied from (${source.x}, ${source.y}) to (${target.x}, ${target.y}) on texture "${texture.name}"`;
      },
    },
    STATUS_EXPERIMENTAL
  );
  
  createTool(
    "eraser_tool",
    {
      description: "Erases parts of textures with customizable settings.",
      annotations: {
        title: "Eraser Tool",
        destructiveHint: true,
      },
      parameters: z.object({
        texture_id: z
          .string()
          .optional()
          .describe(
            "Texture ID or name. If not provided, uses selected texture."
          ),
        coordinates: z
          .array(
            z.object({
              x: z.number().describe("X coordinate to erase at."),
              y: z.number().describe("Y coordinate to erase at."),
            })
          )
          .describe("Array of coordinates to erase at."),
        brush_size: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Eraser brush size."),
        opacity: z
          .number()
          .min(0)
          .max(255)
          .optional()
          .describe("Eraser opacity (0-255)."),
        softness: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Eraser softness percentage."),
        shape: z.enum(["square", "circle"]).optional().describe("Eraser shape."),
        connect_strokes: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether to connect erase strokes with lines."),
      }),
      async execute({
        texture_id,
        coordinates,
        brush_size,
        opacity,
        softness,
        shape,
        connect_strokes,
      }) {
        const texture = texture_id
          ? getProjectTexture(texture_id)
          : Texture.getDefault();
  
        if (!texture) {
          throw new Error(
            texture_id
              ? `Texture with ID "${texture_id}" not found.`
              : "No texture available."
          );
        }
  
        Undo.initEdit({
          textures: [texture],
          bitmap: true,
        });
  
        // Apply settings
        if (brush_size !== undefined) {
          // @ts-ignore
          BarItems.slider_brush_size.set(brush_size);
        }
        if (opacity !== undefined) {
          // @ts-ignore
          BarItems.slider_brush_opacity.set(opacity);
        }
        if (softness !== undefined) {
          // @ts-ignore
          BarItems.slider_brush_softness.set(softness);
        }
        if (shape !== undefined) {
          // @ts-ignore
          BarItems.brush_shape.set(shape);
        }
  
        // Select eraser tool
        // @ts-ignore
        BarItems.eraser.select();
  
        // Erase at coordinates
        for (let i = 0; i < coordinates.length; i++) {
          const coord = coordinates[i];
  
          if (i === 0 || !connect_strokes) {
            // Start new stroke
            Painter.startPaintTool(texture, coord.x, coord.y);
          } else {
            // Continue stroke
            Painter.movePaintTool(texture, coord.x, coord.y, {});
          }
        }
  
        // Finish erasing
        Painter.stopPaintTool();
  
        Undo.finishEdit("Erase texture");
        Canvas.updateAll();
  
        return `Erased ${coordinates.length} points on texture "${texture.name}"`;
      },
    },
    STATUS_EXPERIMENTAL
  );
  
  createTool(
    "paint_settings",
    {
      description: "Configures paint mode settings and preferences.",
      annotations: {
        title: "Paint Settings",
        destructiveHint: true,
      },
      parameters: z.object({
        mirror_painting: z
          .object({
            enabled: z.boolean().describe("Enable mirror painting."),
            axis: z
              .array(z.enum(["x", "y", "z"]))
              .optional()
              .describe("Mirror axes."),
            texture: z.boolean().optional().describe("Enable texture mirroring."),
            texture_center: z
              .tuple([z.number(), z.number()])
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
        brush_opacity_modifier: z
          .enum(["none", "pressure", "tilt"])
          .optional()
          .describe("Brush opacity modifier for stylus."),
        brush_size_modifier: z
          .enum(["none", "pressure", "tilt"])
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
      }),
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
          // @ts-ignore
          BarItems.mirror_painting.set(mirror_painting.enabled);
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
              options.texture_center = mirror_painting.texture_center;
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
          // @ts-ignore
          BarItems.pixel_perfect_drawing.set(pixel_perfect);
          settings.push(`Pixel perfect: ${pixel_perfect}`);
        }
  
        // Color erase mode
        if (color_erase_mode !== undefined) {
          // @ts-ignore
          BarItems.color_erase_mode.set(color_erase_mode);
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
    STATUS_EXPERIMENTAL
  );