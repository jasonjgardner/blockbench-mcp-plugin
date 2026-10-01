/**
 * Parameter schemas for the GeckoLib tools.
 *
 * Kept free of Blockbench runtime globals so the documentation generator can
 * import them outside Blockbench.
 *
 * @module
 */

import { z } from "zod";
import { GECKOLIB_MODEL_TYPES, GECKOLIB_NAMESPACE_PATTERN, GECKOLIB_PATH_PATTERN } from "@/lib/geckolib";
import { GECKOLIB_EASING_DEFAULT, GECKOLIB_EASING_NAMES } from "@/lib/geckolib-easing";
import { animationChannelEnum, animationIdOptionalSchema, boneNameSchema } from "@/lib/zodObjects";

/** Value that clears a keyframe's GeckoLib easing instead of naming one. */
export const CLEAR_EASING = "none";

/** Parameters for tools that read only the active project. */
export const geckolibEmptyParameters = z.object({});

/** Model types the plugin stores on the project. */
export const geckolibModelTypeEnum = z.enum(GECKOLIB_MODEL_TYPES);

/** Easing names plus the explicit clear value. */
export const geckolibEasingEnum = z.enum(
  [...GECKOLIB_EASING_NAMES, CLEAR_EASING] as unknown as [string, ...string[]]
);

/** Shared keyframe-targeting fields: one bone channel, or the timeline selection. */
const keyframeTargetFields = {
  animation_id: animationIdOptionalSchema,
  bone_name: boneNameSchema
    .optional()
    .describe("Bone whose keyframes to target. Omit to act on the current timeline keyframe selection."),
  channel: animationChannelEnum
    .optional()
    .describe("Transform channel to target. Required with bone_name, and meaningless without it."),
  times: z
    .array(z.number().finite().min(0))
    .min(1)
    .optional()
    .describe("Keyframe times in seconds. Requires bone_name; omit to target every keyframe of that channel."),
};

/** Rejects target combinations that would silently act on the wrong keyframes. */
const assertTargetShape = <T extends { bone_name?: string; channel?: string; times?: number[] }>(value: T): boolean =>
  Boolean(value.bone_name) === Boolean(value.channel) && !(value.times && !value.bone_name);

const TARGET_SHAPE_MESSAGE =
  "Pass bone_name and channel together, and times only together with bone_name. Omit all three to target the timeline selection.";

/** Parameters for reading GeckoLib easings off keyframes. */
export const geckolibGetKeyframeEasingParameters = z
  .object({ ...keyframeTargetFields })
  .refine(assertTargetShape, { message: TARGET_SHAPE_MESSAGE });

/** Parameters for writing a GeckoLib easing onto keyframes. */
export const geckolibSetKeyframeEasingParameters = z
  .object({
    ...keyframeTargetFields,
    easing: geckolibEasingEnum.describe(
      `GeckoLib easing name, or "${CLEAR_EASING}" to remove the easing and fall back to ${GECKOLIB_EASING_DEFAULT}.`
    ),
    easing_args: z
      .array(z.number().finite())
      .min(1)
      .optional()
      .describe(
        "Arguments for the Back, Elastic, Bounce and step easings. Omit to use GeckoLib's default (1 overshoot, 0.5 bounciness, 5 steps). Ignored by every other easing."
      ),
    convert_interpolation: z
      .boolean()
      .default(false)
      .describe(
        "Set targeted keyframes to linear interpolation as part of the same edit. GeckoLib wipes easings from catmullrom, step and bezier keyframes on the next render frame, so without this the call is rejected instead of writing an easing that would not survive."
      ),
  })
  .refine(assertTargetShape, { message: TARGET_SHAPE_MESSAGE });

/** Parameters for mirroring easing directions across keyframes. */
export const geckolibReverseKeyframeEasingParameters = z
  .object({ ...keyframeTargetFields })
  .refine(assertTargetShape, { message: TARGET_SHAPE_MESSAGE });

/** Parameters for writing GeckoLib project metadata. */
export const geckolibSetProjectSettingsParameters = z
  .object({
    modid: z
      .string()
      .regex(
        GECKOLIB_NAMESPACE_PATTERN,
        "Mod IDs may only contain lowercase letters, digits, underscore, hyphen and period."
      )
      .optional()
      .describe("Mod namespace exports are written for, e.g. my_mod."),
    model_type: geckolibModelTypeEnum
      .optional()
      .describe(
        "GeckoLib model type. Armor only records the type; it does not generate the plugin's armor template rig, which requires creating a new Armor project in Blockbench."
      ),
    model_identifier: z
      .string()
      .regex(
        GECKOLIB_PATH_PATTERN,
        "Object IDs may only contain lowercase letters, digits, underscore, hyphen, period and forward slash."
      )
      .optional()
      .describe("Registered object ID the geometry exports as (geometry.<identifier>); may include a folder path."),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "Provide at least one of modid, model_type or model_identifier.",
  });

/** Parameters for GeckoLib validation. */
export const geckolibValidateModelParameters = z.object({
  include_animations: z
    .boolean()
    .default(true)
    .describe("Also compile the project's animations and validate their loop values, easings and lengths."),
});

/** Shared export delivery options. */
const exportDeliveryFields = {
  mode: z
    .enum(["compile", "dialog"])
    .default("compile")
    .describe(
      "compile returns the file content without touching the UI. dialog triggers the GeckoLib plugin's own export action, which opens a native save dialog for the user to complete and updates the project's cached export path."
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Absolute filesystem path to write the compiled content to. Requires Blockbench filesystem permission. Only used in compile mode. Fails if the file exists unless overwrite is true."
    ),
  overwrite: z
    .boolean()
    .default(false)
    .describe("Replace an existing file at path. Defaults to false so a re-export never silently replaces a reference file."),
  max_content_length: z
    .number()
    .int()
    .min(0)
    .max(2_000_000)
    .default(100_000)
    .describe("Maximum characters of content to return. Use 0 to omit the content and only report its size."),
};

/** Parameters for exporting GeckoLib geometry. */
export const geckolibExportModelParameters = z.object({ ...exportDeliveryFields });

/** Parameters for exporting GeckoLib animations. */
export const geckolibExportAnimationsParameters = z.object({
  ...exportDeliveryFields,
  animation_ids: z
    .array(z.string())
    .min(1)
    .optional()
    .describe("Animation UUIDs or names to include. Omit to export every animation in the project."),
});

/** A model resource location (optionally namespaced), or an empty string for no parent. */
const DISPLAY_PARENT_PATTERN = /^(?:(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+)?$/;

/** Parameters for exporting GeckoLib display settings. */
export const geckolibExportDisplayParameters = z.object({
  ...exportDeliveryFields,
  parent: z
    .string()
    .regex(DISPLAY_PARENT_PATTERN, "Use a model resource location such as minecraft:item/handheld, or an empty string for no parent.")
    .optional()
    .describe(
      "Parent model to write, compile mode only. Omit to keep the project's parent, which the GeckoLib plugin sets to builtin/entity for Item models and uses as its default, so files match the plugin's own export. Minecraft Java 1.21.4 and later have no builtin/entity model (the result then carries a warning): when targeting them, pass another parent such as minecraft:item/handheld, or an empty string to write none."
    ),
});
