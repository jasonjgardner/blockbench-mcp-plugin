/**
 * Zod schemas for particle effects: a compact design that tools expand into
 * Bedrock particle JSON, and a loose schema for raw particle files.
 *
 * The design covers what most model effects need (emission, motion, size, color,
 * sprite) in plain units, so agents do not have to hand-write Molang for common
 * cases. Anything else goes through `components`, a patch merged over the built
 * JSON. No Blockbench globals: the docs generator imports these schemas.
 *
 * @module
 */

import { z } from "zod";
import { FACING_CAMERA_MODES, PARTICLE_MATERIALS, PARTICLE_SPRITE_NAMES } from "./catalog";

/** `namespace:name`, lowercase, the form Bedrock resolves particle identifiers in. */
export const PARTICLE_IDENTIFIER_PATTERN = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/** A particle identifier such as `mymod:chimney_smoke`. */
export const particleIdentifierSchema = z
  .string()
  .regex(PARTICLE_IDENTIFIER_PATTERN, "Use a lowercase namespace:name identifier, such as mymod:chimney_smoke.")
  .describe("Particle identifier, lowercase namespace:name (for example mymod:chimney_smoke). Do not use the minecraft namespace for new effects.");

/** A Molang expression or a number. */
const molang = z.union([z.number().finite(), z.string().min(1)]);

/** A number, a Molang string, or a [min, max] pair that becomes a random value per particle. */
export const rangeSchema = z.union([
  z.number().finite(),
  z.tuple([z.number().finite(), z.number().finite()]),
  z.string().min(1),
]);

/** A value that may be fixed, random between two bounds, or Molang. */
export type ParticleRange = z.infer<typeof rangeSchema>;

const vec3 = z.tuple([molang, molang, molang]);

/** `#RRGGBB` or `#RRGGBBAA` (CSS order; converted to Bedrock's form on build). */
export const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Use #RRGGBB or #RRGGBBAA.");

/** Where particles spawn. Sizes are in blocks (16 model units). */
export const emitterShapeSchema = z
  .object({
    type: z.enum(["point", "sphere", "box", "disc", "entity_aabb"]).describe("point: one spot. sphere/disc: radius around the emitter. box: half_dimensions. entity_aabb: the entity's hitbox (in-game only; Blockbench previews it as a point)."),
    offset: vec3.optional().describe("Spawn center offset from the emitter, in blocks."),
    radius: molang.optional().describe("Sphere or disc radius in blocks."),
    half_dimensions: vec3.optional().describe("Box half extents in blocks."),
    plane_normal: z.union([z.enum(["x", "y", "z"]), vec3]).optional().describe("Disc facing; y (the default) lays it flat."),
    surface_only: z.boolean().optional().describe("Spawn on the surface/rim instead of throughout the volume."),
  })
  .describe("Emitter shape.");

/** A particle's sprite sheet animation for a custom texture. */
export const flipbookDesignSchema = z.object({
  frame_size: z.tuple([z.number().int().positive(), z.number().int().positive()]).describe("Pixel width and height of one frame."),
  frames: z.number().int().min(2).describe("Frame count."),
  axis: z.enum(["vertical", "horizontal"]).default("vertical").describe("Direction frames are stacked in the image; Blockbench flipbook textures are vertical."),
  fps: z.number().positive().optional().describe("Playback rate. Omit to stretch the frames over each particle's lifetime."),
  loop: z.boolean().optional().describe("Loop the frames when fps is set."),
});

/** Friendly knobs for one particle effect. Everything is optional so a preset can supply the rest. */
export const particleDesignShape = {
  material: z.enum(PARTICLE_MATERIALS).optional().describe("particles_alpha: cutout, cheapest. particles_blend: soft translucency (smoke, glow). particles_add: additive light (fire, magic, sparks). particles_opaque: solid."),
  sprite: z.enum(PARTICLE_SPRITE_NAMES).optional().describe("Built-in sprite; sets the texture and UVs. See list_particle_presets for descriptions."),
  texture: z.string().min(1).optional().describe("Custom Bedrock texture path without .png, such as textures/particle/leaf. Overrides sprite."),
  texture_size: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional().describe("Pixel size of the custom texture. Tools fill it from the PNG when they copy one."),
  flipbook: flipbookDesignSchema.optional().describe("Animate a custom texture as a sprite sheet."),
  rate: z.number().positive().optional().describe("Steady emission, particles per second. Mutually exclusive with burst."),
  burst: z.number().int().positive().optional().describe("Emit this many particles at once when the emitter starts. Mutually exclusive with rate."),
  max_particles: z.number().int().positive().optional().describe("Cap on live particles for a steady emitter."),
  looping: z.boolean().optional().describe("Emitter restarts after duration (+ sleep_time). An existing effect keeps its mode; a new one loops for rate and runs once for burst. Emitters fired from animation keyframes should not loop in Bedrock."),
  duration: z.number().positive().optional().describe("Seconds the emitter is active per cycle. Loops default to 10: with no sleep_time the game emits continuously either way, and Blockbench's preview restarts a looping emitter every `duration` seconds, so keep it at least as long as the clip."),
  sleep_time: z.number().nonnegative().optional().describe("Pause between looping cycles, in seconds."),
  shape: emitterShapeSchema.optional(),
  direction: z.union([z.enum(["outwards", "inwards"]), vec3]).optional().describe("Initial direction: away from or toward the shape center, or a vector such as [0, 1, 0] (up). Molang allowed, e.g. ['math.random(-0.2,0.2)', 1, 0]."),
  local_space: z.boolean().optional().describe("Particles move with the emitter (auras, rings on a moving bone). False leaves them behind (smoke, trails)."),
  lifetime: rangeSchema.optional().describe("Particle lifetime in seconds; [min, max] picks a random value per particle."),
  speed: rangeSchema.optional().describe("Initial speed in blocks per second; [min, max] randomizes it."),
  acceleration: vec3.optional().describe("Blocks per second squared, e.g. [0, -9.8, 0] for gravity or [0, 0.5, 0] for rising smoke."),
  drag: z.number().nonnegative().optional().describe("Linear drag coefficient; 1-3 slows bursts naturally."),
  size: z.union([z.number().positive(), z.tuple([z.number().nonnegative(), z.number().nonnegative()])]).optional().describe("Billboard half-width in blocks (Bedrock sizes are half extents: 0.5 spans a whole block), or [start, end] to grow or shrink over life. Vanilla smoke is 0.1."),
  size_variation: z.number().min(0).max(1).optional().describe("Random size spread per particle, 0-1 (0.3 means +/-15%)."),
  spin: z.object({ initial: rangeSchema.optional(), rate: rangeSchema.optional() }).optional().describe("Billboard rotation in degrees and degrees per second."),
  color: z.union([hexColorSchema, z.array(hexColorSchema).min(2).max(8)]).optional().describe("Tint as #RRGGBB/#RRGGBBAA, or 2-8 colors spread evenly over the particle's life. White keeps a sprite's own colors."),
  fade_out: z.boolean().optional().describe("true fades alpha to zero at the end of life; false makes the end opaque again. Without color it adjusts the current tint. Needs particles_blend or particles_add to look smooth."),
  facing: z.enum(FACING_CAMERA_MODES).optional().describe("Billboard orientation. lookat_xyz faces the camera; lookat_y stays upright; direction_* and lookat_direction stretch along velocity (sparks, rain)."),
  lighting: z.boolean().optional().describe("Shade the particle by world light. Leave off for glowing effects."),
  collision: z
    .object({
      radius: z.number().positive().max(0.5).describe("Collision radius in blocks (Bedrock allows up to 0.5)."),
      bounciness: z.number().min(0).optional().describe("Coefficient of restitution; 0 stops dead, 0.5 bounces."),
      drag: z.number().min(0).optional().describe("Speed lost while sliding."),
      expire_on_contact: z.boolean().optional().describe("Remove the particle when it hits a block (drips, rain)."),
    })
    .optional()
    .describe("Collide with world blocks. Blockbench's preview has no blocks, so collisions only show in game."),
  components: z.record(z.string(), z.unknown()).optional().describe("Raw Bedrock components merged over the built effect, keyed like minecraft:particle_motion_dynamic. Objects merge; null deletes a component or field. Use for anything the knobs do not cover."),
  curves: z.record(z.string(), z.unknown()).optional().describe("Raw Bedrock curves (variable.<name> keys), merged over the built effect."),
  events: z.record(z.string(), z.unknown()).optional().describe("Raw Bedrock events, merged over the built effect."),
} as const;

/** The design knobs as a Zod object. */
export const particleDesignSchema = z.object(particleDesignShape);

/** Design knobs for one particle effect. */
export type ParticleDesign = z.infer<typeof particleDesignSchema>;

/** A raw particle effect file, checked loosely; `validateParticleEffect` explains problems in detail. */
export const particleEffectFileSchema = z
  .object({
    format_version: z.string().optional(),
    particle_effect: z
      .object({
        description: z
          .object({
            identifier: z.string(),
            basic_render_parameters: z.object({ material: z.string(), texture: z.string() }).passthrough(),
          })
          .passthrough(),
        curves: z.record(z.string(), z.unknown()).optional(),
        events: z.record(z.string(), z.unknown()).optional(),
        components: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

/** A Bedrock particle effect file. */
export type ParticleEffectFile = z.infer<typeof particleEffectFileSchema>;
