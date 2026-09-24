/**
 * Checks Bedrock particle files for mistakes that make an effect invisible,
 * silent in game, or expensive, and summarizes what an effect does.
 *
 * Errors mean the effect cannot work as written. Warnings mean it loads but
 * probably does not do what was intended. Messages name the fix, because the
 * readers are agents that will correct the file and try again.
 *
 * @module
 */

import {
  BUILT_IN_TEXTURE_PATHS,
  KNOWN_PARTICLE_COMPONENTS,
  PARTICLE_COUNT_WARNING,
  PARTICLE_MATERIALS,
} from "./catalog";
import { PARTICLE_IDENTIFIER_PATTERN } from "./design";

type JsonRecord = Record<string, unknown>;

/** Outcome of {@link validateParticleEffect}. */
export interface IParticleValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Plain-language facts about one effect, for tool results and packaging. */
export interface IParticleSummary {
  readonly identifier: string;
  readonly material: string;
  readonly texture: string;
  /** Whether the texture ships with the game and Wintersky, so no PNG needs delivering. */
  readonly built_in_texture: boolean;
  readonly emission: string;
  readonly emitter_lifetime: string;
  readonly particle_lifetime: string;
  readonly components: readonly string[];
}

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

const RATE_COMPONENTS = ["minecraft:emitter_rate_steady", "minecraft:emitter_rate_instant", "minecraft:emitter_rate_manual"];
const LIFETIME_COMPONENTS = ["minecraft:emitter_lifetime_looping", "minecraft:emitter_lifetime_once", "minecraft:emitter_lifetime_expression"];

/** Keys whose string values (or arrays of strings) name events. */
const EVENT_REFERENCE_KEYS = new Set(["creation_event", "expiration_event", "event", "effects"]);

/** Collects every event name a component references. */
function referencedEvents(value: unknown, key?: string): string[] {
  if (typeof value === "string") return key !== undefined && EVENT_REFERENCE_KEYS.has(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => referencedEvents(item, key));
  if (!isRecord(value)) return [];
  if (key === "timeline") return Object.values(value).flatMap((item) => referencedEvents(item, "event"));
  return Object.entries(value).flatMap(([childKey, child]) => referencedEvents(child, childKey));
}

/** Alpha values below 1 anywhere in a tint, which alpha-tested materials cut off. */
function tintHasTranslucency(tint: unknown): boolean {
  const color = isRecord(tint) ? tint.color : undefined;
  const stops = isRecord(color) && isRecord(color.gradient) ? Object.values(color.gradient) : [color];
  return stops.some((stop) => {
    if (Array.isArray(stop)) return typeof stop[3] === "number" && stop[3] < 1;
    return typeof stop === "string" && /^#[0-9a-fA-F]{8}$/.test(stop) && stop.slice(1, 3).toLowerCase() !== "ff";
  });
}

const numeric = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * Whether a texture path stays inside the pack it is resolved against. Tools
 * join these paths onto pack folders, so `..`, absolute paths or backslashes
 * could read or write files outside the pack.
 */
export function isSafeTexturePath(texture: string): boolean {
  const segments = texture.split("/");
  return !/\\|^\/|^[a-zA-Z]:/.test(texture) && segments.every((segment) => segment !== ".." && segment !== "." && segment !== "");
}

/** Checks description fields. */
function descriptionIssues(effect: JsonRecord): { errors: string[]; warnings: string[] } {
  const description = isRecord(effect.description) ? effect.description : {};
  const identifier = description.identifier;
  const render = isRecord(description.basic_render_parameters) ? description.basic_render_parameters : {};
  const material = render.material;
  const texture = render.texture;
  const errors = [
    ...(typeof identifier === "string" && PARTICLE_IDENTIFIER_PATTERN.test(identifier) ? [] : ["description.identifier must be a lowercase namespace:name string, such as mymod:chimney_smoke."]),
    ...(typeof material === "string" ? [] : ["description.basic_render_parameters.material is missing; use particles_alpha, particles_blend or particles_add."]),
    ...(typeof texture === "string" && texture ? [] : ["description.basic_render_parameters.texture is missing; use a path like textures/particle/particles."]),
    ...(typeof texture === "string" && texture && !isSafeTexturePath(texture) ? [`Texture path ${texture} must be pack-relative with forward slashes (textures/particle/spark): no "..", drive letters, backslashes or leading slash.`] : []),
  ];
  const warnings = [
    ...(typeof identifier === "string" && identifier.startsWith("minecraft:") ? ["The minecraft namespace replaces a vanilla particle; use your own namespace for new effects."] : []),
    ...(typeof material === "string" && !(PARTICLE_MATERIALS as readonly string[]).includes(material) ? [`Material ${material} is not one Blockbench can preview (${PARTICLE_MATERIALS.join(", ")}).`] : []),
    ...(typeof texture === "string" && /\.png$/i.test(texture) ? ["Texture paths omit the .png extension in Bedrock; remove it."] : []),
  ];
  return { errors, warnings };
}

/** Checks emitter and particle components. */
function componentIssues(components: JsonRecord, material: unknown): { errors: string[]; warnings: string[] } {
  const names = Object.keys(components);
  const has = (name: string): boolean => names.includes(name);
  const steady = isRecord(components["minecraft:emitter_rate_steady"]) ? components["minecraft:emitter_rate_steady"] : undefined;
  const instant = isRecord(components["minecraft:emitter_rate_instant"]) ? components["minecraft:emitter_rate_instant"] : undefined;
  const life = isRecord(components["minecraft:particle_lifetime_expression"]) ? components["minecraft:particle_lifetime_expression"] : undefined;
  const spawnRate = numeric(steady?.spawn_rate);
  const maxParticles = numeric(steady?.max_particles);
  const maxLifetime = numeric(life?.max_lifetime);
  const burst = numeric(instant?.num_particles);
  const errors = [
    ...(RATE_COMPONENTS.some(has) ? [] : ["No emitter rate component, so nothing is emitted; add minecraft:emitter_rate_steady or minecraft:emitter_rate_instant."]),
    ...(LIFETIME_COMPONENTS.some(has) ? [] : ["No emitter lifetime component; add minecraft:emitter_lifetime_looping or minecraft:emitter_lifetime_once."]),
    ...(has("minecraft:particle_appearance_billboard") ? [] : ["No minecraft:particle_appearance_billboard, so particles are invisible."]),
  ];
  const saturated = spawnRate !== undefined && maxParticles !== undefined && maxLifetime !== undefined && spawnRate * maxLifetime > maxParticles * 1.1;
  const warnings = [
    ...names.filter((name) => !KNOWN_PARTICLE_COMPONENTS.has(name)).map((name) => `${name} is not a Bedrock particle component; the game ignores it (check the spelling).`),
    ...(life || !has("minecraft:particle_appearance_billboard") ? [] : ["No minecraft:particle_lifetime_expression, so particles never expire; set max_lifetime."]),
    ...(maxParticles !== undefined && maxParticles > PARTICLE_COUNT_WARNING ? [`max_particles ${maxParticles} is high for one emitter; keep ambient effects under ${PARTICLE_COUNT_WARNING} for mobile players.`] : []),
    ...(burst !== undefined && burst > PARTICLE_COUNT_WARNING ? [`A burst of ${burst} particles is expensive; under ${PARTICLE_COUNT_WARNING} usually reads the same.`] : []),
    ...(saturated ? [`spawn_rate ${spawnRate} x max_lifetime ${maxLifetime}s exceeds max_particles ${maxParticles}, so emission stalls at the cap; raise max_particles or lower the rate.`] : []),
    ...(material === "particles_alpha" && tintHasTranslucency(components["minecraft:particle_appearance_tinting"]) ? ["particles_alpha cuts off partly transparent pixels, so alpha fades pop; use particles_blend or particles_add."] : []),
  ];
  return { errors, warnings };
}

/**
 * Validates a parsed particle effect file.
 *
 * @param file - Parsed JSON; anything is accepted and reported on.
 */
export function validateParticleEffect(file: unknown): IParticleValidation {
  const effect = isRecord(file) && isRecord(file.particle_effect) ? file.particle_effect : undefined;
  if (!effect) return { valid: false, errors: ["Not a particle effect: the top level needs a particle_effect object."], warnings: [] };
  const components = isRecord(effect.components) ? effect.components : undefined;
  if (!components) return { valid: false, errors: ["particle_effect.components must be an object."], warnings: [] };
  const description = descriptionIssues(effect);
  const material = isRecord(effect.description) && isRecord(effect.description.basic_render_parameters) ? effect.description.basic_render_parameters.material : undefined;
  const component = componentIssues(components, material);
  const defined = new Set(isRecord(effect.events) ? Object.keys(effect.events) : []);
  const missingEvents = [...new Set(referencedEvents(components))].filter((name) => !defined.has(name));
  const errors = [...description.errors, ...component.errors];
  const warnings = [
    ...(isRecord(file) && typeof file.format_version === "string" ? [] : ["format_version is missing; use 1.10.0."]),
    ...description.warnings,
    ...component.warnings,
    ...missingEvents.map((name) => `Event ${name} is referenced but not defined in particle_effect.events.`),
  ];
  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Warning for a looping emitter fired from an animation keyframe.
 *
 * Bedrock treats animation-timeline effects as fire-and-forget: a looping
 * emitter never stops, and a looping clip starts another one every cycle.
 * Animation controller states end their emitters on exit, so loops belong
 * there; on a keyframe, a once emitter lasting the clip gives the same look.
 *
 * @param effectName - Keyframe effect name, quoted in the warning.
 * @param looping - Whether the effect uses `minecraft:emitter_lifetime_looping`.
 * @param clipLength - Animation length in seconds, suggested as the replacement duration.
 * @returns The warning, or undefined when the effect is safe on a keyframe.
 */
export function animationTriggerWarning(effectName: string, looping: boolean, clipLength?: number): string | undefined {
  if (!looping) return undefined;
  const duration = clipLength ? ` and duration ${clipLength}` : " and duration set to the clip length";
  return `Effect "${effectName}" loops forever: Bedrock never stops a looping emitter fired from an animation keyframe, and a looping clip starts another each cycle. For keyframes, update it with looping: false${duration} (keyed at 0 on a looping clip), or trigger it from an animation controller state, which ends it on exit.`;
}

/** Whether a parsed effect file loops its emitter. */
export function isLoopingEffect(file: { particle_effect: { components: JsonRecord } }): boolean {
  return "minecraft:emitter_lifetime_looping" in file.particle_effect.components;
}

/** Human-readable emission, such as `steady 6/s (max 20)` or `burst of 24`. */
function describeEmission(components: JsonRecord): string {
  const steady = components["minecraft:emitter_rate_steady"];
  if (isRecord(steady)) return `steady ${String(steady.spawn_rate)}/s (max ${String(steady.max_particles)})`;
  const instant = components["minecraft:emitter_rate_instant"];
  if (isRecord(instant)) return `burst of ${String(instant.num_particles)}`;
  const manual = components["minecraft:emitter_rate_manual"];
  if (isRecord(manual)) return `manual (max ${String(manual.max_particles)}); spawned by game code or events`;
  return "none";
}

/** Human-readable emitter lifetime. */
function describeEmitterLifetime(components: JsonRecord): string {
  const looping = components["minecraft:emitter_lifetime_looping"];
  if (isRecord(looping)) return `looping, ${String(looping.active_time ?? 10)}s active${looping.sleep_time ? `, ${String(looping.sleep_time)}s sleep` : ""}`;
  const once = components["minecraft:emitter_lifetime_once"];
  if (isRecord(once)) return `once, ${String(once.active_time ?? 10)}s`;
  if ("minecraft:emitter_lifetime_expression" in components) return "expression-driven";
  return "none";
}

/**
 * Summarizes an effect that passed schema parsing.
 *
 * @param file - A particle effect file.
 */
export function summarizeParticleEffect(file: { particle_effect: { description: { identifier: string; basic_render_parameters: { material: string; texture: string } }; components: JsonRecord } }): IParticleSummary {
  const { description, components } = file.particle_effect;
  const life = components["minecraft:particle_lifetime_expression"];
  return {
    identifier: description.identifier,
    material: description.basic_render_parameters.material,
    texture: description.basic_render_parameters.texture,
    built_in_texture: BUILT_IN_TEXTURE_PATHS.has(description.basic_render_parameters.texture),
    emission: describeEmission(components),
    emitter_lifetime: describeEmitterLifetime(components),
    particle_lifetime: isRecord(life) ? `${String(life.max_lifetime)}s` : "never expires",
    components: Object.keys(components),
  };
}
