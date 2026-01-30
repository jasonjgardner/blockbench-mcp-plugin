import { z } from "zod";

// ============================================================================
// Vector Schemas
// ============================================================================

/** 2D vector [x, y] */
export const vector2Schema = z
  .array(z.number())
  .length(2)
  .describe("2D vector [x, y].");

/** 3D vector [x, y, z] */
export const vector3Schema = z
  .array(z.number())
  .length(3)
  .describe("3D vector [x, y, z].");

// ============================================================================
// Enum Schemas
// ============================================================================

/** Blend modes for paint tools */
export const blendModeEnum = z.enum([
  "default",
  "set_opacity",
  "color",
  "behind",
  "multiply",
  "add",
  "screen",
  "overlay",
  "difference",
]);

/** Layer blend modes (slightly different set for layers) */
export const layerBlendModeEnum = z.enum([
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
]);

/** Keyframe interpolation types */
export const interpolationEnum = z.enum(["linear", "catmullrom", "bezier", "step"]);

/** Basic 3D axis */
export const axisEnum = z.enum(["x", "y", "z"]);

/** 3D axis with 'all' option */
export const axisWithAllEnum = z.enum(["x", "y", "z", "all"]);

/** Animation channels */
export const animationChannelEnum = z.enum(["rotation", "position", "scale"]);

/** Selection action modes */
export const selectionActionEnum = z.enum(["select", "add", "remove", "toggle"]);

/** Brush shapes */
export const brushShapeEnum = z.enum(["square", "circle"]);

/** Auto UV settings: 0=disabled, 1=enabled, 2=relative */
export const autoUvEnum = z.enum(["0", "1", "2"]);

/** Cube faces */
export const faceEnum = z.enum(["north", "south", "east", "west", "up", "down"]);

/** Camera projection types */
export const projectionEnum = z.enum(["unset", "orthographic", "perspective"]);

/** Mesh selection modes */
export const meshSelectionModeEnum = z.enum(["vertex", "edge", "face"]);

/** UV mapping modes */
export const uvMappingModeEnum = z.enum(["project", "unwrap", "cylinder", "sphere"]);

/** Fill modes for paint fill tool */
export const fillModeEnum = z.enum([
  "color",
  "color_connected",
  "face",
  "element",
  "selected_elements",
  "selection",
]);

/** Shape types for draw shape tool */
export const drawShapeEnum = z.enum(["rectangle", "rectangle_h", "ellipse", "ellipse_h"]);

/** Copy brush modes */
export const copyBrushModeEnum = z.enum(["copy", "sample", "pattern"]);

/** Brush modifier types for stylus */
export const brushModifierEnum = z.enum(["none", "pressure", "tilt"]);

/** PBR texture channels */
export const pbrChannelEnum = z.enum(["color", "normal", "height", "mer"]);

/** Texture render modes */
export const renderModeEnum = z.enum(["default", "emissive", "additive", "layered"]);

/** Texture render sides */
export const renderSidesEnum = z.enum(["auto", "front", "double"]);

/** Loop modes for animation */
export const loopModeEnum = z.enum(["once", "loop", "hold"]);

// ============================================================================
// Color Schemas
// ============================================================================

/** Flexible color input: RGBA array, hex string, or named color */
export const colorSchema = z.union([
  z
    .array(z.number().min(0).max(255))
    .length(4)
    .describe("RGBA [R, G, B, A]"),
  z
    .string()
    .regex(
      /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/,
      "Hex color #RRGGBB or #RRGGBBAA"
    ),
  z.string().regex(/^[a-z]{3,20}$/, "Named color"),
]);

/** Hex color string */
export const hexColorSchema = z
  .string()
  .optional()
  .describe("Color as hex string (e.g., #FF0000).");

// ============================================================================
// Time/Range Schemas
// ============================================================================

/** Time range with start and end */
export const timeRangeSchema = z.object({
  start: z.number().describe("Start time in seconds."),
  end: z.number().describe("End time in seconds."),
});

// ============================================================================
// ID/Reference Schemas
// ============================================================================

/** Required element ID or name */
export const elementIdSchema = z
  .string()
  .describe("ID or name of the element.");

/** Optional mesh ID with fallback to selected */
export const meshIdOptionalSchema = z
  .string()
  .optional()
  .describe("ID or name of the mesh. If not provided, uses selected mesh.");

/** Required mesh ID */
export const meshIdSchema = z
  .string()
  .describe("ID or name of the mesh.");

/** Optional texture ID with fallback to selected */
export const textureIdOptionalSchema = z
  .string()
  .optional()
  .describe("Texture ID or name. If not provided, uses selected texture.");

/** Required texture ID */
export const textureIdSchema = z
  .string()
  .describe("Texture ID or name.");

/** Optional animation ID with fallback to current */
export const animationIdOptionalSchema = z
  .string()
  .optional()
  .describe("Animation UUID or name. If not provided, uses current animation.");

/** Optional group/bone ID */
export const groupIdOptionalSchema = z
  .string()
  .optional()
  .describe("Group/bone ID or name.");

/** Required bone name */
export const boneNameSchema = z
  .string()
  .describe("Name of the bone/group.");

// ============================================================================
// Common Parameter Schemas
// ============================================================================

/** Opacity value 0-255 */
export const opacitySchema = z
  .number()
  .min(0)
  .max(255)
  .optional()
  .describe("Opacity (0-255).");

/** Brush size 1-100 */
export const brushSizeSchema = z
  .number()
  .min(1)
  .max(100)
  .optional()
  .describe("Brush size.");

/** Brush softness 0-100 */
export const brushSoftnessSchema = z
  .number()
  .min(0)
  .max(100)
  .optional()
  .describe("Brush softness percentage.");

/** 2D coordinate point */
export const coordinateSchema = z.object({
  x: z.number().describe("X coordinate."),
  y: z.number().describe("Y coordinate."),
});

// ============================================================================
// Composite Schemas (using base schemas)
// ============================================================================

/** Cube element schema */
export const cubeSchema = z.object({
  name: z.string(),
  origin: vector3Schema
    .optional()
    .default([0, 0, 0])
    .describe("Pivot point of the cube."),
  from: vector3Schema
    .optional()
    .default([0, 0, 0])
    .describe("Starting point of the cube."),
  to: vector3Schema
    .optional()
    .default([1, 1, 1])
    .describe("Ending point of the cube."),
  rotation: vector3Schema
    .optional()
    .default([0, 0, 0])
    .describe("Rotation of the cube."),
});

/** Mesh element schema */
export const meshSchema = z.object({
  name: z.string(),
  position: vector3Schema
    .optional()
    .default([0, 0, 0])
    .describe("Position of the mesh."),
  rotation: vector3Schema
    .optional()
    .default([0, 0, 0])
    .describe("Rotation of the mesh."),
  scale: vector3Schema
    .optional()
    .default([1, 1, 1])
    .describe("Scale of the mesh."),
  vertices: z
    .array(vector3Schema.describe("Vertex coordinates in the mesh."))
    .optional()
    .default([])
    .describe("Vertices of the mesh."),
});

/** Keyframe data for animation tools */
export const keyframeDataSchema = z.object({
  time: z.number().describe("Time in seconds for the keyframe."),
  values: z
    .union([vector3Schema, z.number()])
    .optional()
    .describe("Values: [x,y,z] for position/rotation, number for uniform scale."),
  interpolation: interpolationEnum
    .optional()
    .default("linear")
    .describe("Interpolation type for the keyframe."),
  bezier_handles: z
    .object({
      left_time: z.number().optional(),
      left_value: z.union([vector3Schema, z.number()]).optional(),
      right_time: z.number().optional(),
      right_value: z.union([vector3Schema, z.number()]).optional(),
    })
    .optional()
    .describe("Bezier handle positions for bezier interpolation."),
});

/** Brush settings for paint tools */
export const brushSettingsSchema = z
  .object({
    size: brushSizeSchema,
    opacity: opacitySchema,
    softness: brushSoftnessSchema,
    shape: brushShapeEnum.optional().describe("Brush shape."),
    color: hexColorSchema.describe("Brush color as hex string."),
    blend_mode: blendModeEnum.optional().describe("Brush blend mode."),
  })
  .optional()
  .describe("Brush settings to apply.");
