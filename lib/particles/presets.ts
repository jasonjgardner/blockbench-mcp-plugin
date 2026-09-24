/**
 * Starting points for common model effects, expressed as design knobs.
 *
 * Values follow Mojang's vanilla particle definitions where one exists (smoke,
 * campfire smoke, soul, bubbles, drips) and are tuned for readable effects on
 * props and entities elsewhere. Every preset uses a built-in texture, so a
 * fresh effect previews in Blockbench and runs in game with no texture file.
 * Units are blocks (16 model units) and seconds.
 *
 * @module
 */

import type { ParticleDesign } from "./design";

/** How a preset is meant to be triggered from an animation. */
export type ParticleTrigger = "continuous" | "one_shot";

/** A named starting point. */
export interface IParticlePreset {
  readonly description: string;
  /** Continuous effects loop; one-shots fire once per keyframe (impacts, spells). */
  readonly trigger: ParticleTrigger;
  readonly design: ParticleDesign;
}

const JITTER_UP: ParticleDesign["direction"] = ["math.random(-0.15, 0.15)", 1, "math.random(-0.15, 0.15)"];
const TWINKLE = "0.15 * math.sin(180 * variable.particle_age / variable.particle_lifetime)";

/** Every preset, keyed by name. */
export const PARTICLE_PRESETS = {
  smoke: {
    description: "Gray puffs rising from a chimney, exhaust or extinguished flame.",
    trigger: "continuous",
    design: { sprite: "puff", material: "particles_blend", rate: 6, lifetime: [1.5, 2.5], speed: [0.2, 0.4], direction: JITTER_UP, acceleration: [0, 0.35, 0], drag: 0.4, size: [0.12, 0.35], size_variation: 0.3, color: ["#8a8a8acc", "#5a5a5a"], fade_out: true, shape: { type: "sphere", radius: 0.1 }, lighting: true },
  },
  campfire_smoke: {
    description: "Tall, soft smoke column like a vanilla campfire; large and slow.",
    trigger: "continuous",
    design: { sprite: "campfire_smoke", material: "particles_blend", rate: 3, lifetime: [4, 6], speed: [0.3, 0.6], direction: [0, 1, 0], acceleration: [0, 0.3, 0], size: [0.4, 0.8], color: ["#ffffffcc", "#bbbbbb"], fade_out: true, shape: { type: "disc", radius: 0.25 }, lighting: true },
  },
  fire: {
    description: "Animated flames licking upward from a fire pit, brazier or burning part.",
    trigger: "continuous",
    design: { sprite: "fire", material: "particles_blend", rate: 12, lifetime: [0.5, 0.9], speed: [0.3, 0.6], direction: [0, 1, 0], acceleration: [0, 1, 0], size: [0.25, 0.08], size_variation: 0.4, fade_out: true, shape: { type: "disc", radius: 0.2 } },
  },
  flame: {
    description: "One small steady flame for a torch, candle or lantern wick.",
    trigger: "continuous",
    design: { sprite: "flame", material: "particles_alpha", rate: 4, lifetime: [0.4, 0.7], speed: 0.05, direction: [0, 1, 0], acceleration: [0, 0.15, 0], size: [0.12, 0.02], shape: { type: "point" } },
  },
  embers: {
    description: "Glowing specks drifting up from a forge, fire or lava.",
    trigger: "continuous",
    design: { sprite: "ember", material: "particles_add", rate: 6, lifetime: [1.5, 3], speed: [0.3, 0.8], direction: ["math.random(-0.3, 0.3)", 1, "math.random(-0.3, 0.3)"], acceleration: [0, 0.4, 0], drag: 0.5, size: [0.06, 0.02], size_variation: 0.5, color: ["#ffd27a", "#ff5a1a"], fade_out: true, shape: { type: "disc", radius: 0.3 } },
  },
  sparks: {
    description: "Burst of hot sparks that fall and bounce: grinding, impacts, short circuits.",
    trigger: "one_shot",
    design: { sprite: "sparkler", material: "particles_add", burst: 24, duration: 0.1, lifetime: [0.4, 0.9], speed: [2, 4], direction: "outwards", shape: { type: "sphere", radius: 0.05 }, acceleration: [0, -9.8, 0], drag: 1, size: 0.08, color: ["#fff3b0", "#ff9d2e"], fade_out: true, collision: { radius: 0.05, bounciness: 0.3, drag: 0.4 } },
  },
  magic: {
    description: "Swirling spell motes rising around a caster, rune or enchanted item.",
    trigger: "continuous",
    design: { sprite: "spell", material: "particles_add", rate: 10, lifetime: [1, 1.6], speed: [0.1, 0.3], direction: "outwards", shape: { type: "sphere", radius: 0.4, surface_only: true }, acceleration: [0, 0.6, 0], size: [0.12, 0.05], color: ["#d9a6ff", "#7a3cff"], fade_out: true, local_space: true, spin: { initial: [0, 360], rate: [-90, 90] } },
  },
  sparkle: {
    description: "Stars that twinkle in and out over an area: treasure, polish, fairy dust.",
    trigger: "continuous",
    design: { sprite: "star", material: "particles_add", rate: 5, lifetime: [0.5, 0.9], speed: 0, shape: { type: "box", half_dimensions: [0.5, 0.5, 0.5] }, color: "#fff6c8", components: { "minecraft:particle_appearance_billboard": { size: [TWINKLE, TWINKLE] } } },
  },
  glow: {
    description: "Soft pulsing light halo around a lamp, crystal or eye; a cheap fake bloom.",
    trigger: "continuous",
    design: { sprite: "glow", material: "particles_add", rate: 2, max_particles: 4, lifetime: 1.2, speed: 0, shape: { type: "point" }, size: [0.5, 0.6], color: ["#ffcf6600", "#ffcf66aa", "#ffcf6600"], local_space: true },
  },
  dust: {
    description: "Slow motes hanging in the air of a room, cave or sunbeam.",
    trigger: "continuous",
    design: { sprite: "dot", material: "particles_blend", rate: 4, lifetime: [3, 5], speed: [0.02, 0.05], direction: ["math.random(-1, 1)", "math.random(-0.2, 0.2)", "math.random(-1, 1)"], shape: { type: "box", half_dimensions: [1, 0.6, 1] }, acceleration: [0, -0.03, 0], size: 0.04, size_variation: 0.5, color: ["#e8dcc000", "#e8dcc0cc", "#e8dcc000"], lighting: true },
  },
  snow: {
    description: "Flakes drifting down in a swaying fall, spawned on a plane above the model.",
    trigger: "continuous",
    design: { sprite: "dot", material: "particles_alpha", rate: 20, lifetime: [3, 4], speed: 0.3, direction: [0, -1, 0], shape: { type: "box", half_dimensions: [2, 0.1, 2], offset: [0, 2, 0] }, size: 0.06, size_variation: 0.4, color: "#ffffff", collision: { radius: 0.05, expire_on_contact: true }, components: { "minecraft:particle_motion_dynamic": { linear_acceleration: ["math.sin(variable.particle_age * 90 + variable.particle_random_1 * 360) * 0.4", -0.1, "math.cos(variable.particle_age * 90 + variable.particle_random_2 * 360) * 0.4"] } } },
  },
  drip: {
    description: "Occasional drops falling from a pipe, leak, stalactite or wet surface.",
    trigger: "continuous",
    design: { sprite: "small_dot", material: "particles_alpha", rate: 1.5, lifetime: 2, speed: 0, shape: { type: "point" }, acceleration: [0, -6, 0], size: 0.08, color: "#4a7dff", collision: { radius: 0.05, expire_on_contact: true } },
  },
  bubbles: {
    description: "Wobbling bubbles rising from a cauldron, potion, aquarium or diving gear.",
    trigger: "continuous",
    design: { sprite: "bubble", material: "particles_alpha", rate: 5, lifetime: [1.5, 2.5], speed: 0.3, direction: [0, 1, 0], shape: { type: "disc", radius: 0.3 }, size: 0.12, size_variation: 0.5, components: { "minecraft:particle_motion_dynamic": { linear_acceleration: ["math.sin(variable.particle_age * 400 + variable.particle_random_1 * 360) * 0.8", 0.6, "math.cos(variable.particle_age * 400 + variable.particle_random_2 * 360) * 0.8"] } } },
  },
  hearts: {
    description: "A few hearts floating up once: taming, breeding, affection.",
    trigger: "one_shot",
    design: { sprite: "heart", material: "particles_alpha", burst: 6, duration: 0.1, lifetime: [1, 1.5], speed: [0.3, 0.6], direction: ["math.random(-0.3, 0.3)", 1, "math.random(-0.3, 0.3)"], shape: { type: "sphere", radius: 0.4 }, acceleration: [0, 0.2, 0], drag: 1, size: [0.2, 0.15] },
  },
  poof: {
    description: "Outward cloud burst for spawning, landing, despawning or a small explosion.",
    trigger: "one_shot",
    design: { sprite: "puff", material: "particles_blend", burst: 20, duration: 0.1, lifetime: [0.6, 1.2], speed: [1, 2.5], direction: "outwards", shape: { type: "sphere", radius: 0.2 }, drag: 2.5, acceleration: [0, 0.4, 0], size: [0.2, 0.4], size_variation: 0.4, color: ["#ffffff", "#9a9a9a"], fade_out: true, lighting: true },
  },
  soul: {
    description: "Cyan soul wisps rising and swelling, as over soul sand or soul fire.",
    trigger: "continuous",
    design: { sprite: "soul", material: "particles_blend", rate: 3, lifetime: [1, 1.8], speed: [0.1, 0.3], direction: [0, 1, 0], shape: { type: "disc", radius: 0.25 }, acceleration: [0, 0.3, 0], size: [0.1, 0.35] },
  },
  portal: {
    description: "Motes spiraling in from a sphere to its center: portals, charging, absorption.",
    trigger: "continuous",
    design: { sprite: "dot", material: "particles_add", rate: 15, lifetime: 0.9, speed: [0.8, 1.2], direction: "inwards", shape: { type: "sphere", radius: 1, surface_only: true }, size: [0.08, 0.02], color: ["#c77dff", "#5a189a"], local_space: true },
  },
  steam: {
    description: "Fast jet of steam or gas from a vent, valve or nostril; point it with a rotated locator.",
    trigger: "continuous",
    design: { sprite: "puff", material: "particles_blend", rate: 14, lifetime: [0.6, 1], speed: [2.5, 3.5], direction: ["math.random(-0.1, 0.1)", 1, "math.random(-0.1, 0.1)"], drag: 2, acceleration: [0, 0.5, 0], size: [0.05, 0.3], color: ["#ffffffcc", "#ffffff"], fade_out: true, shape: { type: "point" } },
  },
  electric: {
    description: "Crackling blue sparks around a coil, charged weapon or electrified mob.",
    trigger: "continuous",
    design: { sprite: "star", material: "particles_add", rate: 12, lifetime: [0.1, 0.25], speed: [0.5, 1.5], direction: "outwards", shape: { type: "sphere", radius: 0.3, surface_only: true }, size: 0.12, size_variation: 0.6, color: ["#e6f7ff", "#5fb8ff"], spin: { initial: [0, 360] } },
  },
} satisfies Record<string, IParticlePreset>;

/** A preset name. */
export type ParticlePresetName = keyof typeof PARTICLE_PRESETS;

/** Every preset name, for enum schemas. */
export const PARTICLE_PRESET_NAMES = Object.keys(PARTICLE_PRESETS) as [ParticlePresetName, ...ParticlePresetName[]];
