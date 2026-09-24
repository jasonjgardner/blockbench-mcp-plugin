/**
 * Expands particle design knobs into Bedrock particle JSON.
 *
 * Each knob group is an applier that rewrites only the components it owns, so
 * the same code builds a new effect from a skeleton and patches an existing,
 * possibly hand-written, file without disturbing the rest of it. Every function
 * returns new objects; inputs are never mutated.
 *
 * @module
 */

import {
  type IParticleSprite,
  PARTICLE_FORMAT_VERSION,
  PARTICLE_SPRITES,
} from "./catalog";
import type { ParticleDesign, ParticleEffectFile, ParticleRange } from "./design";

/** A JSON object. */
type JsonRecord = Record<string, unknown>;

type Molang = number | string;

/** Components that decide how many particles an emitter makes. */
const RATE_COMPONENTS = ["minecraft:emitter_rate_steady", "minecraft:emitter_rate_instant", "minecraft:emitter_rate_manual"];
/** Components that decide how long an emitter runs. */
const EMITTER_LIFETIME_COMPONENTS = ["minecraft:emitter_lifetime_looping", "minecraft:emitter_lifetime_once", "minecraft:emitter_lifetime_expression"];
/** Components that decide where particles spawn. */
const SHAPE_COMPONENTS = [
  "minecraft:emitter_shape_point",
  "minecraft:emitter_shape_sphere",
  "minecraft:emitter_shape_box",
  "minecraft:emitter_shape_disc",
  "minecraft:emitter_shape_entity_aabb",
  "minecraft:emitter_shape_custom",
];

const BILLBOARD = "minecraft:particle_appearance_billboard";
const LIFE_FRACTION = "variable.particle_age / variable.particle_lifetime";

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

const round = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * JSON merge patch (RFC 7386): objects merge recursively, `null` deletes a key,
 * and every other value (arrays included) replaces what was there.
 *
 * @param base - Value to patch; left unchanged.
 * @param patch - Changes to apply.
 * @returns The patched copy.
 */
export function mergePatch(base: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) return patch;
  const start: JsonRecord = isRecord(base) ? base : {};
  return Object.entries(patch).reduce<JsonRecord>((merged, [key, value]) => {
    if (value === null) {
      const { [key]: _removed, ...rest } = merged;
      return rest;
    }
    return { ...merged, [key]: mergePatch(merged[key], value) };
  }, { ...start });
}

/**
 * Converts `#RRGGBB` or `#RRGGBBAA` to the `[r, g, b, a]` 0-1 array Bedrock and
 * Wintersky both read without byte-order ambiguity.
 */
export function hexToParticleColor(hex: string): [number, number, number, number] {
  const digits = hex.slice(1);
  const channel = (index: number): number => round(parseInt(digits.slice(index * 2, index * 2 + 2), 16) / 255);
  return [channel(0), channel(1), channel(2), digits.length === 8 ? channel(3) : 1];
}

/**
 * Turns a range knob into Molang: numbers pass through, `[min, max]` becomes
 * `math.random(min, max)`, and strings are taken as Molang already.
 */
export function rangeToMolang(range: ParticleRange): Molang {
  if (!Array.isArray(range)) return range;
  const [min, max] = range;
  return min === max ? min : `math.random(${min}, ${max})`;
}

/** Upper bound a range can reach, for particle budget estimates; unknown for Molang. */
function rangeMax(range: ParticleRange | undefined): number | undefined {
  if (typeof range === "number") return range;
  if (Array.isArray(range)) return Math.max(...range);
  return undefined;
}

/**
 * The effect name animations use for an identifier: the part after the
 * namespace, reduced to the characters Blockbench's effect field keeps.
 */
export function shortNameOf(identifier: string): string {
  const name = identifier.includes(":") ? identifier.slice(identifier.indexOf(":") + 1) : identifier;
  return name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "effect";
}

const components = (file: ParticleEffectFile): JsonRecord => file.particle_effect.components;

/** Returns the file with its components replaced. */
function withComponents(file: ParticleEffectFile, next: JsonRecord): ParticleEffectFile {
  return { ...file, particle_effect: { ...file.particle_effect, components: next } };
}

/** Merges `patch` into one component, creating it when absent. */
function patchComponent(file: ParticleEffectFile, name: string, patch: unknown): ParticleEffectFile {
  return withComponents(file, { ...components(file), [name]: mergePatch(components(file)[name], patch) });
}

/** Sets one component outright. */
function setComponent(file: ParticleEffectFile, name: string, value: unknown): ParticleEffectFile {
  return withComponents(file, { ...components(file), [name]: value });
}

/** Removes the listed components. */
function removeComponents(file: ParticleEffectFile, names: readonly string[]): ParticleEffectFile {
  return withComponents(file, Object.fromEntries(Object.entries(components(file)).filter(([name]) => !names.includes(name))));
}

/** The first of `names` present in the file, with its value. */
function findComponent(file: ParticleEffectFile, names: readonly string[]): [string, JsonRecord] | undefined {
  const name = names.find((candidate) => candidate in components(file));
  if (name === undefined) return undefined;
  const value = components(file)[name];
  return [name, isRecord(value) ? value : {}];
}

/** Sets description fields such as the texture or material. */
function patchRenderParameters(file: ParticleEffectFile, patch: JsonRecord): ParticleEffectFile {
  const description = file.particle_effect.description;
  return {
    ...file,
    particle_effect: {
      ...file.particle_effect,
      description: { ...description, basic_render_parameters: { ...description.basic_render_parameters, ...patch } },
    },
  };
}

/** Billboard UV block for a built-in sprite. */
function spriteUv(sprite: IParticleSprite): JsonRecord {
  const size = { texture_width: sprite.texture_width, texture_height: sprite.texture_height };
  if (sprite.flipbook) return { ...size, flipbook: sprite.flipbook };
  return { ...size, uv: sprite.uv, uv_size: sprite.uv_size };
}

/** The pixel size recorded in a billboard's UV block, when it holds numbers. */
function existingTextureSize(file: ParticleEffectFile): [number, number] | undefined {
  const uv = (findComponent(file, [BILLBOARD])?.[1] ?? {}).uv;
  if (!isRecord(uv) || typeof uv.texture_width !== "number" || typeof uv.texture_height !== "number") return undefined;
  return [uv.texture_width, uv.texture_height];
}

/** Billboard UV block for a custom texture, static or as a flipbook. */
function customUv(design: ParticleDesign, knownSize: [number, number] | undefined): JsonRecord {
  const flipbook = design.flipbook;
  if (flipbook) {
    const [width, height] = flipbook.frame_size;
    const vertical = flipbook.axis === "vertical";
    const [textureWidth, textureHeight] = design.texture_size ?? (vertical ? [width, height * flipbook.frames] : [width * flipbook.frames, height]);
    return {
      texture_width: textureWidth,
      texture_height: textureHeight,
      flipbook: {
        base_UV: [0, 0],
        size_UV: [width, height],
        step_UV: vertical ? [0, height] : [width, 0],
        frames_per_second: flipbook.fps ?? flipbook.frames,
        max_frame: flipbook.frames,
        stretch_to_lifetime: flipbook.fps === undefined,
        ...(flipbook.loop === undefined ? {} : { loop: flipbook.loop }),
      },
    };
  }
  const size = design.texture_size ?? knownSize;
  if (!size) throw new Error("A custom texture needs texture_size [width, height] (or a flipbook) so its UVs can be set.");
  return { texture_width: size[0], texture_height: size[1], uv: [0, 0], uv_size: size };
}

/** Material, sprite or custom texture and its UVs. */
function applyAppearanceSource(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  const withMaterial = design.material ? patchRenderParameters(file, { material: design.material }) : file;
  const custom = design.texture !== undefined || design.texture_size !== undefined || design.flipbook !== undefined;
  if (custom) {
    const current = withMaterial.particle_effect.description.basic_render_parameters.texture;
    const texture = design.texture ?? current;
    // A size recorded for a different image says nothing about the new one.
    const uv = customUv(design, texture === current ? existingTextureSize(withMaterial) : undefined);
    return patchComponent(removeUv(patchRenderParameters(withMaterial, { texture })), BILLBOARD, { uv });
  }
  if (!design.sprite) return withMaterial;
  const sprite = PARTICLE_SPRITES[design.sprite];
  return patchComponent(removeUv(patchRenderParameters(withMaterial, { texture: sprite.texture })), BILLBOARD, { uv: spriteUv(sprite) });
}

/** Drops a billboard's UV block so a new one replaces it instead of merging into it. */
function removeUv(file: ParticleEffectFile): ParticleEffectFile {
  return patchComponent(file, BILLBOARD, { uv: null });
}

/** The file's particle lifetime when it is a plain number. */
function numericLifetime(file: ParticleEffectFile): number | undefined {
  const lifetime = findComponent(file, ["minecraft:particle_lifetime_expression"])?.[1].max_lifetime;
  return typeof lifetime === "number" ? lifetime : undefined;
}

/** Steady or burst emission and the live-particle cap. */
function applyEmission(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  if (design.rate !== undefined && design.burst !== undefined) throw new Error("Use rate (steady) or burst (instant), not both.");
  if (design.rate !== undefined) {
    const lifetime = rangeMax(design.lifetime) ?? numericLifetime(file) ?? 1;
    const estimate = Math.min(1000, Math.max(20, Math.ceil(design.rate * lifetime * 1.25)));
    // An existing cap survives a rate change unless it would now throttle emission.
    const previous = findComponent(file, ["minecraft:emitter_rate_steady", "minecraft:emitter_rate_manual"])?.[1].max_particles;
    const kept = typeof previous === "number" && previous >= estimate ? previous : estimate;
    return setComponent(removeComponents(file, RATE_COMPONENTS), "minecraft:emitter_rate_steady", { spawn_rate: design.rate, max_particles: design.max_particles ?? kept });
  }
  if (design.burst !== undefined) return setComponent(removeComponents(file, RATE_COMPONENTS), "minecraft:emitter_rate_instant", { num_particles: design.burst });
  if (design.max_particles === undefined) return file;
  const capped = findComponent(file, ["minecraft:emitter_rate_steady", "minecraft:emitter_rate_manual"]);
  if (!capped) throw new Error("max_particles applies to steady emitters; this effect emits a burst.");
  return patchComponent(file, capped[0], { max_particles: design.max_particles });
}

/**
 * Whether the emitter should loop: an explicit knob first, then the file's
 * current mode, and only for a file without one the emission kind (bursts
 * run once, steady emitters loop). Changing the rate must never turn a
 * deliberately finite emitter back into a loop.
 */
function resolveLooping(file: ParticleEffectFile, design: ParticleDesign): boolean {
  if (design.looping !== undefined) return design.looping;
  const current = findComponent(file, EMITTER_LIFETIME_COMPONENTS);
  if (current) return current[0] === "minecraft:emitter_lifetime_looping";
  return design.burst === undefined;
}

/**
 * Active time for looping emitters. With no sleep the game emits continuously
 * whatever this is, but Blockbench's preview wraps a looping emitter's time by
 * it (Wintersky `Emitter.jumpTo`) and restarts it, clearing live particles, so
 * a short value makes a steady effect flicker in the preview.
 */
export const DEFAULT_LOOP_ACTIVE_TIME = 10;

/** How long the emitter runs and whether it repeats. */
function applyEmitterLifetime(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  const explicit = [design.looping, design.duration, design.sleep_time].some((value) => value !== undefined);
  const needsDefault = !findComponent(file, EMITTER_LIFETIME_COMPONENTS) && (design.rate !== undefined || design.burst !== undefined);
  if (!explicit && !needsDefault) return file;
  const looping = resolveLooping(file, design);
  const mode = looping ? "minecraft:emitter_lifetime_looping" : "minecraft:emitter_lifetime_once";
  // A burst's 0.1 s is no duration for a steady loop, so only the same mode keeps its timing.
  const found = findComponent(file, EMITTER_LIFETIME_COMPONENTS);
  const existing = found?.[0] === mode ? found[1] : {};
  const activeTime = design.duration ?? existing.active_time ?? (looping ? DEFAULT_LOOP_ACTIVE_TIME : 1);
  const sleepTime = design.sleep_time ?? existing.sleep_time;
  const cleared = removeComponents(file, EMITTER_LIFETIME_COMPONENTS);
  if (!looping) return setComponent(cleared, "minecraft:emitter_lifetime_once", { active_time: activeTime });
  return setComponent(cleared, "minecraft:emitter_lifetime_looping", { active_time: activeTime, ...(sleepTime === undefined ? {} : { sleep_time: sleepTime }) });
}

/** A random unit-ish direction; point emitters have no center to push away from. */
const RANDOM_DIRECTION: readonly Molang[] = ["math.random(-1, 1)", "math.random(-1, 1)", "math.random(-1, 1)"];

const PLANE_NORMALS: Readonly<Record<string, readonly number[]>> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Direction value valid for the given shape component. */
function directionFor(shapeName: string, direction: ParticleDesign["direction"] | unknown): unknown {
  const named = direction === "outwards" || direction === "inwards";
  if (shapeName === "minecraft:emitter_shape_point" && named) return RANDOM_DIRECTION;
  return direction;
}

/** Changes to a shape of the same type: only the fields the knob sets, so radius, offset and the rest survive. */
function shapePatch(name: string, shape: NonNullable<ParticleDesign["shape"]>, direction: ParticleDesign["direction"]): JsonRecord {
  const normal = shape.plane_normal;
  return {
    ...(shape.offset ? { offset: shape.offset } : {}),
    ...(shape.radius === undefined ? {} : { radius: shape.radius }),
    ...(shape.half_dimensions ? { half_dimensions: shape.half_dimensions } : {}),
    ...(normal === undefined ? {} : { plane_normal: typeof normal === "string" ? PLANE_NORMALS[normal] : normal }),
    ...(shape.surface_only === undefined || shape.type === "point" ? {} : { surface_only: shape.surface_only }),
    ...(direction === undefined ? {} : { direction: directionFor(name, direction) }),
  };
}

/** Emitter shape and initial direction. */
function applyShape(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  const shape = design.shape;
  const existing = findComponent(file, SHAPE_COMPONENTS);
  if (!shape) {
    if (design.direction === undefined || !existing) return file;
    return patchComponent(file, existing[0], { direction: directionFor(existing[0], design.direction) });
  }
  const name = `minecraft:emitter_shape_${shape.type}`;
  if (existing?.[0] === name) return patchComponent(file, name, shapePatch(name, shape, design.direction));
  // A new shape type starts from defaults; a point's [0, 1, 0] is no sensible sphere direction.
  const fallbackDirection = shape.type === "point" ? [0, 1, 0] : "outwards";
  const direction = directionFor(name, design.direction ?? fallbackDirection);
  const normal = shape.plane_normal ?? "y";
  const byType: Readonly<Record<string, JsonRecord>> = {
    point: {},
    sphere: { radius: shape.radius ?? 0.5 },
    box: { half_dimensions: shape.half_dimensions ?? [0.5, 0.5, 0.5] },
    disc: { radius: shape.radius ?? 0.5, plane_normal: typeof normal === "string" ? PLANE_NORMALS[normal] : normal },
    entity_aabb: {},
  };
  const surface = shape.surface_only === undefined || shape.type === "point" ? {} : { surface_only: shape.surface_only };
  const value = { ...(shape.offset ? { offset: shape.offset } : {}), ...byType[shape.type], ...surface, direction };
  return setComponent(removeComponents(file, SHAPE_COMPONENTS), name, value);
}

/** Whether particles follow the emitter's movement. */
function applyLocalSpace(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  if (design.local_space === undefined) return file;
  if (!design.local_space) return removeComponents(file, ["minecraft:emitter_local_space"]);
  return setComponent(file, "minecraft:emitter_local_space", { position: true, rotation: true });
}

/** Lifetime, launch speed, acceleration and drag. */
function applyMotion(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  const withLife = design.lifetime === undefined ? file : patchComponent(file, "minecraft:particle_lifetime_expression", { max_lifetime: rangeToMolang(design.lifetime) });
  const withSpeed = design.speed === undefined ? withLife : setComponent(withLife, "minecraft:particle_initial_speed", rangeToMolang(design.speed));
  const dynamics = {
    ...(design.acceleration ? { linear_acceleration: design.acceleration } : {}),
    ...(design.drag === undefined ? {} : { linear_drag_coefficient: design.drag }),
  };
  if (Object.keys(dynamics).length === 0) return withSpeed;
  return patchComponent(withSpeed, "minecraft:particle_motion_dynamic", dynamics);
}

/** Billboard size, optionally interpolated over life and varied per particle. */
function applySize(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  if (design.size === undefined) {
    if (design.size_variation !== undefined) throw new Error("size_variation needs size.");
    return file;
  }
  const base: Molang = typeof design.size === "number" ? design.size : `math.lerp(${design.size[0]}, ${design.size[1]}, ${LIFE_FRACTION})`;
  const variation = design.size_variation ?? 0;
  const value: Molang = variation > 0 ? `(${base}) * (1 + (variable.particle_random_3 - 0.5) * ${variation})` : base;
  return patchComponent(file, BILLBOARD, { size: [value, value] });
}

/** Initial rotation and spin rate. */
function applySpin(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  if (!design.spin) return file;
  return patchComponent(file, "minecraft:particle_initial_spin", {
    ...(design.spin.initial === undefined ? {} : { rotation: rangeToMolang(design.spin.initial) }),
    ...(design.spin.rate === undefined ? {} : { rotation_rate: rangeToMolang(design.spin.rate) }),
  });
}

type Rgba = [number, number, number, number];

/** A gradient stop: position over life (0-1) and color. */
interface IColorStop {
  readonly at: number;
  readonly color: Rgba;
}

const TINTING = "minecraft:particle_appearance_tinting";

const isRgba = (value: unknown): value is Rgba => Array.isArray(value) && value.length === 4 && value.every((entry) => typeof entry === "number");

/**
 * The file's current tint as stops, so a fade can be added to it.
 *
 * @throws Error when the tint uses Molang or hex values the knobs cannot adjust.
 */
function existingStops(file: ParticleEffectFile): IColorStop[] {
  const tint = components(file)[TINTING];
  if (tint === undefined) return [{ at: 0, color: [1, 1, 1, 1] }];
  const color = isRecord(tint) ? tint.color : undefined;
  if (isRgba(color)) return [{ at: 0, color }];
  const gradient = isRecord(color) && isRecord(color.gradient) ? Object.entries(color.gradient) : [];
  const stops = gradient.map(([at, value]) => ({ at: Number(at), color: value }));
  const parsed = stops.filter((stop): stop is IColorStop => Number.isFinite(stop.at) && isRgba(stop.color));
  if (!parsed.length || parsed.length !== stops.length) {
    throw new Error("The current tint uses Molang or hex colors that fade_out cannot adjust; pass color to replace it.");
  }
  return parsed.toSorted((a, b) => a.at - b.at);
}

/** Stops for explicit colors, spread evenly over life. */
function stopsFromColors(color: string | string[]): IColorStop[] {
  const colors = Array.isArray(color) ? color : [color];
  return colors.map((hex, index) => ({ at: colors.length === 1 ? 0 : index / (colors.length - 1), color: hexToParticleColor(hex) }));
}

/** Color stops for the requested tint and fade, starting from the file's tint when no color is given. */
function colorStops(file: ParticleEffectFile, design: ParticleDesign): IColorStop[] {
  const base = design.color === undefined ? existingStops(file) : stopsFromColors(design.color);
  const last = base.at(-1);
  if (design.fade_out === undefined || !last) return base;
  const alpha = design.fade_out ? 0 : 1;
  const ending: IColorStop = { at: base.length === 1 ? 1 : last.at, color: [last.color[0], last.color[1], last.color[2], alpha] };
  // A single color gains a transparent end stop; otherwise the last stop's alpha changes.
  if (base.length === 1 && design.fade_out) return [last, ending];
  if (base.length === 1) return [{ at: 0, color: ending.color }];
  return [...base.slice(0, -1), ending];
}

/** Static tint or a gradient over the particle's life. */
function applyColor(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  if (design.color === undefined && design.fade_out === undefined) return file;
  const stops = colorStops(file, design);
  const [only] = stops;
  if (stops.length === 1 && only) return setComponent(file, TINTING, { color: only.color });
  const gradient = Object.fromEntries(stops.map((stop) => [stop.at.toFixed(2), stop.color]));
  return setComponent(file, TINTING, { color: { gradient, interpolant: LIFE_FRACTION } });
}

/** Billboard facing; velocity-aligned modes also need a direction source. */
function applyFacing(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  if (!design.facing) return file;
  const alongVelocity = design.facing.startsWith("direction_") || design.facing === "lookat_direction";
  return patchComponent(file, BILLBOARD, {
    facing_camera_mode: design.facing,
    ...(alongVelocity ? { direction: { mode: "derive_from_velocity", min_speed_threshold: 0.01 } } : {}),
  });
}

/** Adds or removes world lighting. */
function applyLighting(file: ParticleEffectFile, lighting: boolean | undefined): ParticleEffectFile {
  if (lighting === undefined) return file;
  if (!lighting) return removeComponents(file, ["minecraft:particle_appearance_lighting"]);
  return setComponent(file, "minecraft:particle_appearance_lighting", {});
}

/** World lighting and block collisions. */
function applyEnvironment(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  const lit = applyLighting(file, design.lighting);
  const collision = design.collision;
  if (!collision) return lit;
  return setComponent(lit, "minecraft:particle_motion_collision", {
    collision_radius: collision.radius,
    ...(collision.bounciness === undefined ? {} : { coefficient_of_restitution: collision.bounciness }),
    ...(collision.drag === undefined ? {} : { collision_drag: collision.drag }),
    ...(collision.expire_on_contact === undefined ? {} : { expire_on_contact: collision.expire_on_contact }),
  });
}

/** Raw components, curves and events, merged last so they override the knobs. */
function applyRawPatches(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  const effect = file.particle_effect;
  const patched = {
    ...effect,
    components: design.components ? (mergePatch(effect.components, design.components) as JsonRecord) : effect.components,
    ...(design.curves ? { curves: mergePatch(effect.curves, design.curves) as JsonRecord } : {}),
    ...(design.events ? { events: mergePatch(effect.events, design.events) as JsonRecord } : {}),
  };
  return { ...file, particle_effect: patched };
}

const APPLIERS: readonly ((file: ParticleEffectFile, design: ParticleDesign) => ParticleEffectFile)[] = [
  applyAppearanceSource,
  applyEmission,
  applyEmitterLifetime,
  applyShape,
  applyLocalSpace,
  applyMotion,
  applySize,
  applySpin,
  applyColor,
  applyFacing,
  applyEnvironment,
  applyRawPatches,
];

/**
 * Applies design knobs to an existing effect. Only the components a knob owns
 * change; everything else in the file, including hand-written Molang, stays.
 *
 * @throws Error for contradictory knobs (rate with burst) or a custom texture without a size.
 */
export function applyParticleDesign(file: ParticleEffectFile, design: ParticleDesign): ParticleEffectFile {
  return APPLIERS.reduce((current, apply) => apply(current, design), file);
}

/**
 * The shared starting point for new effects: white dots drifting up. It has
 * no rate or emitter lifetime; {@link buildParticleEffect} always sets an
 * emission, and the emitter lifetime follows from it.
 */
export function particleSkeleton(identifier: string): ParticleEffectFile {
  return {
    format_version: PARTICLE_FORMAT_VERSION,
    particle_effect: {
      description: { identifier, basic_render_parameters: { material: "particles_alpha", texture: PARTICLE_SPRITES.dot.texture } },
      components: {
        "minecraft:emitter_shape_point": { direction: [0, 1, 0] },
        "minecraft:particle_lifetime_expression": { max_lifetime: 1 },
        "minecraft:particle_initial_speed": 1,
        "minecraft:particle_motion_dynamic": {},
        [BILLBOARD]: { size: [0.1, 0.1], facing_camera_mode: "lookat_xyz", uv: spriteUv(PARTICLE_SPRITES.dot) },
      },
    },
  };
}

/** Steady rate for a new effect that names neither rate nor burst. */
const DEFAULT_RATE = 8;

/**
 * Composes two merge patches into one that has the effect of applying `first`
 * then `second`. Unlike {@link mergePatch}, a `null` in `second` survives, so a
 * deletion still reaches the document the composed patch is applied to.
 */
export function composePatches(first: unknown, second: unknown): unknown {
  if (!isRecord(first) || !isRecord(second)) return second === undefined ? first : second;
  return Object.entries(second).reduce<JsonRecord>(
    (composed, [key, value]) => ({ ...composed, [key]: value === null ? null : composePatches(composed[key], value) }),
    { ...first },
  );
}

/** Knobs that exclude each other: setting one in an override clears the others from the base. */
const EXCLUSIVE_KNOBS: readonly (readonly (keyof ParticleDesign)[])[] = [
  ["rate", "burst"],
  ["sprite", "texture"],
];

/**
 * Layers an override design over a base design, such as user knobs over a
 * preset. Scalar knobs replace; `components`, `curves` and `events` compose so
 * both sets of raw patches apply. Choosing `burst` drops a base `rate` (and the
 * reverse), and choosing `texture` drops a base `sprite` (and the reverse).
 */
export function mergeDesigns(base: ParticleDesign, override: ParticleDesign): ParticleDesign {
  const cleared = EXCLUSIVE_KNOBS.reduce<ParticleDesign>((design, group) => {
    const chosen = group.find((knob) => override[knob] !== undefined);
    if (chosen === undefined) return design;
    return Object.fromEntries(Object.entries(design).filter(([key]) => !group.includes(key as keyof ParticleDesign) || key === chosen));
  }, base);
  // A burst preset's 0.1 s duration or a loop's cap means nothing for the other emission kind.
  const switchesKind = (override.rate !== undefined && base.burst !== undefined) || (override.burst !== undefined && base.rate !== undefined);
  const timing: readonly string[] = ["looping", "duration", "sleep_time", "max_particles"];
  const retimed: ParticleDesign = switchesKind ? Object.fromEntries(Object.entries(cleared).filter(([key]) => !timing.includes(key))) : cleared;
  const definedOverrides = Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined));
  const raw = (key: "components" | "curves" | "events"): Partial<ParticleDesign> => {
    const composed = composePatches(retimed[key], override[key]);
    return composed === undefined ? {} : { [key]: composed as Record<string, unknown> };
  };
  return { ...retimed, ...definedOverrides, ...raw("components"), ...raw("curves"), ...raw("events") };
}

/**
 * Builds a complete effect from design knobs over {@link particleSkeleton}.
 *
 * @param identifier - `namespace:name` identifier written to the description.
 * @param designs - Designs layered with {@link mergeDesigns}, such as a preset followed by overrides.
 */
export function buildParticleEffect(identifier: string, ...designs: readonly ParticleDesign[]): ParticleEffectFile {
  const design = designs.reduce(mergeDesigns, {});
  const emitting = design.rate === undefined && design.burst === undefined ? { ...design, rate: DEFAULT_RATE } : design;
  return applyParticleDesign(particleSkeleton(identifier), emitting);
}
