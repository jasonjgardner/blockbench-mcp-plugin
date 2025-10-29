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

createTool(
  "paint_with_brush",
  {
    description:
      "Paints on textures using the brush tool with customizable settings.",
    annotations: {
      title: "Paint with Brush",
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
            x: z.number().describe("X coordinate on texture."),
            y: z.number().describe("Y coordinate on texture."),
          })
        )
        .describe("Array of coordinates to paint at."),
      brush_settings: z
        .object({
          size: z.number().min(1).max(100).optional().describe("Brush size."),
          opacity: z
            .number()
            .min(0)
            .max(255)
            .optional()
            .describe("Brush opacity (0-255)."),
          softness: z
            .number()
            .min(0)
            .max(100)
            .optional()
            .describe("Brush softness percentage."),
          shape: z
            .enum(["square", "circle"])
            .optional()
            .describe("Brush shape."),
          color: z.string().optional().describe("Brush color as hex string."),
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
            .describe("Brush blend mode."),
        })
        .optional()
        .describe("Brush settings to apply."),
      connect_strokes: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to connect paint strokes with lines."),
    }),
    async execute({
      texture_id,
      coordinates,
      brush_settings,
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
        selected_texture: true,
        bitmap: true,
      });

      // Apply brush settings using .value assignment
      BarItems.slider_brush_size.value = brush_settings.size;
      BarItems.slider_brush_opacity.value = brush_settings.opacity;
      BarItems.slider_brush_softness.value = brush_settings.softness;
      BarItems.brush_shape.value = brush_settings.shape;
      ColorPanel.set(brush_settings.color);

      // Paint using Painter.edit() method
      texture.edit(
        (canvas) => {
          const ctx = canvas.getContext("2d");
          for (const coord of coordinates) {
            if (brush_settings.shape === "circle") {
              Painter.editCircle(
                ctx,
                coord.x,
                coord.y,
                brush_settings.size,
                brush_settings.softness,
                (r, g, b, a) => [red, green, blue, alpha]
              );
            } else {
              Painter.editSquare(
                ctx,
                coord.x,
                coord.y,
                brush_settings.size,
                brush_settings.softness,
                (r, g, b, a) => [red, green, blue, alpha]
              );
            }
          }
        },
        { edit_name: "Paint with brush" }
      );

      Undo.finishEdit("Paint with brush");
      Canvas.updateAll();

      return `Painted ${coordinates.length} points on texture "${texture.name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "create_brush_preset",
  {
    description: "Creates a custom brush preset with specified settings.",
    annotations: {
      title: "Create Brush Preset",
      destructiveHint: true,
    },
    parameters: z.object({
      name: z.string().describe("Name of the brush preset."),
      size: z.number().min(1).max(100).optional().describe("Brush size."),
      opacity: z
        .number()
        .min(0)
        .max(255)
        .optional()
        .describe("Brush opacity (0-255)."),
      softness: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Brush softness percentage."),
      shape: z.enum(["square", "circle"]).optional().describe("Brush shape."),
      color: z.string().optional().describe("Brush color as hex string."),
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
        .describe("Brush blend mode."),
      pixel_perfect: z
        .boolean()
        .optional()
        .describe("Enable pixel perfect drawing."),
    }),
    async execute({
      name,
      size,
      opacity,
      softness,
      shape,
      color,
      blend_mode,
      pixel_perfect,
    }) {
      const preset = {
        name,
        size: size || null,
        opacity: opacity || null,
        softness: softness || null,
        shape: shape || "square",
        color: color || null,
        blend_mode: blend_mode || "default",
        pixel_perfect: pixel_perfect || false,
      };

      // @ts-ignore
      StateMemory.brush_presets.push(preset);
      // @ts-ignore
      StateMemory.save("brush_presets");

      return `Created brush preset "${name}" with settings: ${JSON.stringify(
        preset
      )}`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "load_brush_preset",
  {
    description: "Loads and applies a brush preset by name.",
    annotations: {
      title: "Load Brush Preset",
      destructiveHint: true,
    },
    parameters: z.object({
      preset_name: z.string().describe("Name of the brush preset to load."),
    }),
    async execute({ preset_name }) {
      // @ts-ignore
      const preset = StateMemory.brush_presets.find(
        (p) => p.name === preset_name
      );

      if (!preset) {
        throw new Error(`Brush preset "${preset_name}" not found.`);
      }

      // @ts-ignore
      Painter.loadBrushPreset(preset);

      return `Loaded brush preset "${preset_name}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

createTool(
  "texture_selection",
  {
    description:
      "Creates, modifies, or manipulates texture selections for painting.",
    annotations: {
      title: "Texture Selection",
      destructiveHint: true,
    },
    parameters: z.object({
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
      texture_id: z
        .string()
        .optional()
        .describe(
          "Texture ID or name. If not provided, uses selected texture."
        ),
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
    }),
    async execute({ action, texture_id, coordinates, radius, mode }) {
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
          selection.selectAll();
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
  STATUS_EXPERIMENTAL
);

createTool(
  "texture_layer_management",
  {
    description: "Creates, manages, and manipulates texture layers.",
    annotations: {
      title: "Texture Layer Management",
      destructiveHint: true,
    },
    parameters: z.object({
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
      texture_id: z
        .string()
        .optional()
        .describe(
          "Texture ID or name. If not provided, uses selected texture."
        ),
      layer_name: z.string().optional().describe("Name of the layer."),
      opacity: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Layer opacity percentage."),
      blend_mode: z
        .enum([
          "normal",
          "multiply",
          "screen",
          "overlay",
          "soft_light",
          "hard_light",
          "color_dodge",
          "color_burn",
          "darken",
          "lighten",
          "difference",
          "exclusion",
        ])
        .optional()
        .describe("Layer blend mode."),
      target_index: z
        .number()
        .optional()
        .describe("Target position for moving layers."),
    }),
    async execute({
      action,
      texture_id,
      layer_name,
      opacity,
      blend_mode,
      target_index,
    }) {
      const texture = texture_id
        ? getProjectTexture(texture_id)
        : Texture.selected;

      if (!texture) {
        throw new Error(
          texture_id
            ? `Texture with ID "${texture_id}" not found.`
            : "No texture selected."
        );
      }

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
  STATUS_EXPERIMENTAL
);
