import { z } from "zod";
import { particleDesignSchema, particleIdentifierSchema } from "@/lib/particles/design";
import { PARTICLE_PRESET_NAMES } from "@/lib/particles/presets";
import { animationIdOptionalSchema, vector3Schema } from "@/lib/zodObjects";

/** An effect already known to the project: identifier, effect name, or JSON path. */
const effectReference = z
  .string()
  .min(1)
  .describe("Particle identifier (mymod:smoke), effect name (smoke), or absolute path to the effect's .json file. A path that is not loaded yet is loaded.");

/** PNG to use as a custom particle texture. */
const textureImageSchema = z
  .object({
    texture: z.string().min(1).optional().describe("Blockbench texture UUID or name to save as the particle texture (paint or generate it first)."),
    path: z.string().min(1).optional().describe("Absolute path to a PNG file to copy."),
    name: z.string().min(1).optional().describe("File name under textures/particle/; defaults to the effect name."),
  })
  .refine((value) => (value.texture === undefined) !== (value.path === undefined), "Pass exactly one of texture or path.")
  .describe("Custom texture for the effect. It is saved to <pack_root>/textures/particle/<name>.png and the effect's texture and texture_size are set from it (keep design.sprite unset).");

const packRootSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Absolute resource-pack-style folder that receives particles/<name>.json and textures/particle/*.png. Defaults to the pack of a Bedrock entity opened from a resource pack, else the saved project's folder.");

/** Input for `create_particle_effect`. */
export const createParticleEffectParameters = z.object({
  identifier: particleIdentifierSchema,
  preset: z.enum(PARTICLE_PRESET_NAMES).optional().describe("Starting point; list_particle_presets describes each. design knobs override it."),
  design: particleDesignSchema.optional().describe("Knobs layered over the preset (or over a plain default effect). Units are blocks (16 model units) and seconds."),
  raw: z.record(z.string(), z.unknown()).optional().describe("A complete Bedrock particle file (for example a Snowstorm export) instead of preset/design. Its identifier is replaced by `identifier`."),
  texture_image: textureImageSchema.optional(),
  pack_root: packRootSchema,
  overwrite: z.boolean().default(false).describe("Replace an existing effect file (and texture) with the same name."),
});

/** Input for `update_particle_effect`. */
export const updateParticleEffectParameters = z.object({
  effect: effectReference,
  design: particleDesignSchema.optional().describe("Knobs to change. Only the components a knob owns are rewritten; hand-written parts of the file stay."),
  raw: z.record(z.string(), z.unknown()).optional().describe("Replace the whole file with this Bedrock particle JSON. The effect keeps its current identifier, so keyframes and the client entity still match."),
  texture_image: textureImageSchema.optional(),
  overwrite: z.boolean().default(false).describe("Replace a texture PNG that already exists with different content (another effect may use it)."),
});

/** Input for `list_particle_effects`. */
export const listParticleEffectsParameters = z.object({
  include_json: z.boolean().default(false).describe("Include each effect's full JSON."),
});

/** Input for `list_particle_presets`. */
export const listParticlePresetsParameters = z.object({
  include_designs: z.boolean().default(true).describe("Include each preset's design knobs, useful as a template for custom effects."),
});

/** One particle keyframe to add. */
const particleKeyframeSchema = z.object({
  time: z.number().finite().nonnegative().describe("Seconds from the start of the animation."),
  effect: z.string().min(1).describe("Effect to spawn: identifier, effect name or JSON path of a loaded effect. For GeckoLib, a name your mod's particle handler understands also works (without a preview)."),
  effect_name: z.string().regex(/^[a-z0-9_.]+$/).optional().describe("Name written to the keyframe and used in the client entity's particle_effects map; defaults to the effect's short name."),
  locator: z.string().min(1).optional().describe("Locator the effect spawns at and follows. Omit to spawn at the entity origin."),
  pre_effect_script: z.string().optional().describe("Molang run before the emitter starts, for variables such as variable.color = 1;"),
  bind_to_actor: z.boolean().default(true).describe("Bedrock: keep the emitter attached to the entity. False leaves it in the world where it spawned."),
});

/** Input for `manage_particle_keyframes`. */
export const manageParticleKeyframesParameters = z.object({
  animation_id: animationIdOptionalSchema,
  action: z.enum(["add", "remove", "list"]).describe("add particle keyframes, remove them by time, or list them."),
  keyframes: z.array(particleKeyframeSchema).max(200).optional().describe("Keyframes for add. A keyframe at an existing particle time joins that keyframe as another effect."),
  times: z.array(z.number().finite().nonnegative()).max(200).optional().describe("Times (seconds) to remove for remove; omit to remove every particle keyframe."),
  effect_filter: z.string().min(1).optional().describe("For remove: only effects with this name, identifier or file."),
});

/** Input for `add_locator`. */
export const addLocatorParameters = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_]+$/).describe("Unique locator name; particle keyframes refer to it."),
  parent: z.string().min(1).optional().describe("Bone/group name or UUID the locator follows. Omit for the model root."),
  position: vector3Schema.describe("Absolute position in model units (16 per block), like a cube corner."),
  rotation: vector3Schema.optional().describe("Degrees; orients effects whose shapes or directions use local space (formats with rotatable locators)."),
  ignore_inherited_scale: z.boolean().optional().describe("Keep effect size when the parent bone scales."),
});

/** Input for `export_particle_pack`. */
export const exportParticlePackParameters = z.object({
  destination: z.string().min(1).describe("Absolute path to the resource pack root (the folder containing manifest.json)."),
  effects: z.array(effectReference).optional().describe("Effects to deliver. Defaults to every effect used by particle keyframes in the project."),
  overwrite: z.boolean().default(false).describe("Replace files that exist with different content. Identical files are always skipped."),
});
