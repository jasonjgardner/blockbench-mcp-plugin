/**
 * Reference data for Bedrock particle effects (the Snowstorm format).
 *
 * Blockbench previews particle keyframes with Wintersky, which reads this
 * format, and Minecraft Bedrock and GeckoLib consume the same JSON. Everything
 * here is plain data with no Blockbench globals, so the desktop plugin, the
 * headless server and the docs generator all share it.
 *
 * Sprite coordinates were read from Mojang's vanilla particle definitions
 * (`bedrock-samples/resource_pack/particles/*.json`) and match the atlas that
 * Wintersky bundles, so a preview shows the same sprite as the game.
 *
 * @module
 */

/** Format version Snowstorm writes; every current Bedrock release accepts it. */
export const PARTICLE_FORMAT_VERSION = "1.10.0";

/** Particle materials Bedrock ships and Wintersky renders. */
export const PARTICLE_MATERIALS = ["particles_alpha", "particles_blend", "particles_add", "particles_opaque"] as const;

/** A Bedrock particle material. */
export type ParticleMaterial = (typeof PARTICLE_MATERIALS)[number];

/** Billboard facing modes Wintersky renders. */
export const FACING_CAMERA_MODES = [
  "lookat_xyz",
  "lookat_y",
  "rotate_xyz",
  "rotate_y",
  "direction_x",
  "direction_y",
  "direction_z",
  "lookat_direction",
  "emitter_transform_xy",
  "emitter_transform_xz",
  "emitter_transform_yz",
] as const;

/** A billboard facing mode. */
export type FacingCameraMode = (typeof FACING_CAMERA_MODES)[number];

/**
 * Every `minecraft:` component the Bedrock particle format defines. Wintersky
 * previews all of them, so an unknown name is almost always a typo that the
 * game will silently ignore.
 */
export const KNOWN_PARTICLE_COMPONENTS: ReadonlySet<string> = new Set([
  "minecraft:emitter_initialization",
  "minecraft:emitter_local_space",
  "minecraft:emitter_rate_instant",
  "minecraft:emitter_rate_steady",
  "minecraft:emitter_rate_manual",
  "minecraft:emitter_lifetime_looping",
  "minecraft:emitter_lifetime_once",
  "minecraft:emitter_lifetime_expression",
  "minecraft:emitter_lifetime_events",
  "minecraft:emitter_shape_point",
  "minecraft:emitter_shape_sphere",
  "minecraft:emitter_shape_box",
  "minecraft:emitter_shape_custom",
  "minecraft:emitter_shape_entity_aabb",
  "minecraft:emitter_shape_disc",
  "minecraft:particle_initialization",
  "minecraft:particle_initial_speed",
  "minecraft:particle_initial_spin",
  "minecraft:particle_kill_plane",
  "minecraft:particle_lifetime_expression",
  "minecraft:particle_lifetime_events",
  "minecraft:particle_expire_if_in_blocks",
  "minecraft:particle_expire_if_not_in_blocks",
  "minecraft:particle_motion_dynamic",
  "minecraft:particle_motion_parametric",
  "minecraft:particle_motion_collision",
  "minecraft:particle_appearance_billboard",
  "minecraft:particle_appearance_tinting",
  "minecraft:particle_appearance_lighting",
]);

/** A vanilla particle texture that both the game and Wintersky provide. */
export interface IBuiltInParticleTexture {
  /** Bedrock texture path, without the `.png` extension. */
  readonly path: string;
  /** Pixel size of the image. */
  readonly width: number;
  readonly height: number;
  /** What the image holds, so an agent can pick one without seeing it. */
  readonly description: string;
}

/**
 * Textures that exist in the vanilla resource pack and in Wintersky's bundle.
 * An effect using one of these needs no texture file in the delivered pack.
 */
export const BUILT_IN_PARTICLE_TEXTURES: readonly IBuiltInParticleTexture[] = [
  { path: "textures/particle/particles", width: 128, height: 128, description: "Vanilla particle atlas: 8x8 sprites for smoke puffs, flames, bubbles, hearts, notes, crits, spells, sparks and a 32x32 soft glow. Use a named sprite rather than raw UVs." },
  { path: "textures/flame_atlas", width: 16, height: 512, description: "32 stacked 16x16 fire frames (the entity-on-fire overlay)." },
  { path: "textures/particle/soul", width: 16, height: 176, description: "11 stacked 16x16 frames of a cyan soul wisp." },
  { path: "textures/particle/campfire_smoke", width: 16, height: 192, description: "12 stacked 16x16 variations of a large soft smoke cloud." },
];

/** Paths Wintersky resolves without a file; `textures/particle/flame_atlas` is its alias for the flame atlas. */
export const BUILT_IN_TEXTURE_PATHS: ReadonlySet<string> = new Set([...BUILT_IN_PARTICLE_TEXTURES.map((texture) => texture.path), "textures/particle/flame_atlas"]);

/** A flipbook: frames laid out in a strip, advanced over time or over the particle's life. */
export interface IFlipbook {
  readonly base_UV: readonly [number, number];
  readonly size_UV: readonly [number, number];
  readonly step_UV: readonly [number, number];
  readonly frames_per_second: number;
  readonly max_frame: number;
  readonly stretch_to_lifetime: boolean;
  readonly loop?: boolean;
}

/** A named sprite inside a built-in texture. */
export interface IParticleSprite {
  readonly texture: string;
  readonly texture_width: number;
  readonly texture_height: number;
  /** Static sprite position and size; ignored when `flipbook` is set. */
  readonly uv?: readonly [number | string, number | string];
  readonly uv_size?: readonly [number, number];
  readonly flipbook?: IFlipbook;
  /** Whether the sprite is already colored; tinting multiplies it. */
  readonly colored: boolean;
  readonly description: string;
}

const ATLAS = { texture: "textures/particle/particles", texture_width: 128, texture_height: 128 } as const;

/** Builds an atlas flipbook that runs once over each particle's life. */
const atlasFlipbook = (base: [number, number], step: [number, number], frames: number): IFlipbook => ({
  base_UV: base,
  size_UV: [8, 8],
  step_UV: step,
  frames_per_second: 8,
  max_frame: frames,
  stretch_to_lifetime: true,
});

/**
 * Named sprites. Grayscale sprites take any tint; colored sprites keep their
 * own palette, so tint them white (or leave the color unset).
 */
export const PARTICLE_SPRITES = {
  puff: { ...ATLAS, flipbook: atlasFlipbook([56, 0], [-8, 0], 8), colored: false, description: "Soft round puff that shrinks from large to a dot over the particle's life (vanilla smoke and poof)." },
  dot: { ...ATLAS, uv: [0, 0], uv_size: [8, 8], colored: false, description: "One-pixel dot; reads as dust, snow or distant sparks." },
  small_dot: { ...ATLAS, uv: [8, 56], uv_size: [8, 8], colored: false, description: "Small square dot (vanilla water drip); tint for drops, rain or embers." },
  bubble: { ...ATLAS, uv: [0, 16], uv_size: [8, 8], colored: true, description: "Blue outlined bubble." },
  flame: { ...ATLAS, uv: [0, 24], uv_size: [8, 8], colored: true, description: "Small torch flame." },
  ember: { ...ATLAS, uv: [10, 26], uv_size: [4, 4], colored: true, description: "Tiny glowing lava speck." },
  note: { ...ATLAS, uv: [0, 32], uv_size: [8, 8], colored: false, description: "Music note; tint it." },
  heart: { ...ATLAS, uv: [0, 40], uv_size: [8, 8], colored: true, description: "Red heart." },
  angry: { ...ATLAS, uv: [8, 40], uv_size: [8, 8], colored: true, description: "Gray storm cloud with a spark (angry villager)." },
  happy: { ...ATLAS, uv: [16, 40], uv_size: [8, 8], colored: true, description: "Green sparkle (happy villager)." },
  drop: { ...ATLAS, uv: [0, 48], uv_size: [8, 8], colored: true, description: "Blue hanging water drop." },
  star: { ...ATLAS, uv: [16, 48], uv_size: [8, 8], colored: false, description: "White four-point star; the glint for sparkles and electric sparks." },
  glow: { ...ATLAS, uv: [32, 16], uv_size: [32, 32], colored: false, description: "32x32 soft radial glow; a light halo or aura with particles_add or particles_blend." },
  spell: { ...ATLAS, flipbook: atlasFlipbook([0, 64], [8, 0], 8), colored: false, description: "Swirl that unwinds over life (vanilla potion spell)." },
  crit: { ...ATLAS, flipbook: atlasFlipbook([0, 72], [8, 0], 8), colored: false, description: "Cross-shaped star that grows over life (vanilla critical hit)." },
  spark: { ...ATLAS, flipbook: { base_UV: [0, 80], size_UV: [8, 8], step_UV: [8, 0], frames_per_second: 8, max_frame: 16, stretch_to_lifetime: true }, colored: false, description: "Firework spark: a dot that swells into a ring and fades, 16 frames." },
  twinkle: { ...ATLAS, flipbook: atlasFlipbook([56, 88], [-8, 0], 8), colored: false, description: "Glint that shrinks as it fades (vanilla end rod)." },
  sparkler: { ...ATLAS, flipbook: { base_UV: [64, 96], size_UV: [8, 8], step_UV: [-8, 0], frames_per_second: 10, max_frame: 9, stretch_to_lifetime: true }, colored: false, description: "Sparkler spark, 9 frames." },
  fire: { texture: "textures/flame_atlas", texture_width: 16, texture_height: 512, flipbook: { base_UV: [0, 0], size_UV: [16, 16], step_UV: [0, 16], frames_per_second: 32, max_frame: 32, stretch_to_lifetime: false, loop: true }, colored: true, description: "Animated fire, 32 frames looping at 32 fps." },
  soul: { texture: "textures/particle/soul", texture_width: 16, texture_height: 176, flipbook: { base_UV: [0, 0], size_UV: [16, 16], step_UV: [0, 16], frames_per_second: 11, max_frame: 11, stretch_to_lifetime: true }, colored: true, description: "Cyan soul wisp, 11 frames over life." },
  campfire_smoke: { texture: "textures/particle/campfire_smoke", texture_width: 16, texture_height: 192, uv: [0, "math.floor(variable.particle_random_2 * 12) * 16"], uv_size: [16, 16], colored: false, description: "Large soft smoke cloud; each particle picks one of 12 variations." },
} as const satisfies Record<string, IParticleSprite>;

/** Name of a built-in sprite. */
export type ParticleSpriteName = keyof typeof PARTICLE_SPRITES;

/** Every sprite name, for enum schemas. */
export const PARTICLE_SPRITE_NAMES = Object.keys(PARTICLE_SPRITES) as [ParticleSpriteName, ...ParticleSpriteName[]];

/** Blockbench model units per Bedrock block; particle sizes, speeds and offsets are in blocks. */
export const MODEL_UNITS_PER_BLOCK = 16;

/**
 * Live particles above which a single emitter is likely to cost frame rate on
 * mobile Bedrock clients. A soft budget for warnings, not a game limit.
 */
export const PARTICLE_COUNT_WARNING = 200;
