/**
 * Edit operations for particle effects in `.bbmodel` documents: locators and
 * particle keyframes on an animation's Effects track.
 *
 * Blockbench saves the Effects track under the `effects` animator key, with
 * each particle keyframe holding data points `{effect, locator, script, file,
 * bind_to_actor}`. A relative `file` resolves against the model's folder when
 * Blockbench opens it, so headless writes `particles/<name>.json` style paths
 * that survive moving the project. Locators are saved elements of type
 * `locator` with an absolute `position`.
 *
 * @module
 */

import { z } from "zod";
import { type DataPoint, type IAnimation, type IBBModel, type IKeyframe, type IOtherElement, vec3Schema } from "../document/schema";
import { indexModel, insertNode, resolveNode } from "../document/tree";
import { findAnimation, freshUuid } from "./refs";

/** Animator key Blockbench uses for the Effects track. */
export const EFFECTS_ANIMATOR_KEY = "effects";

const KEY_EPSILON = 1e-6;

/** Adds a locator: a named point particles spawn at and follow. */
export const addLocatorOp = z.object({
  op: z.literal("add_locator"),
  name: z.string().regex(/^[a-zA-Z0-9_]+$/, "Locator names use letters, digits and underscores."),
  parent: z.string().min(1).nullable().optional().describe("Group UUID or name the locator follows; null or omitted places it at the root."),
  position: vec3Schema.describe("Absolute model position (16 units per block), like a cube corner."),
  rotation: vec3Schema.optional().describe("Degrees; orients effects that use local space."),
  ignore_inherited_scale: z.boolean().optional(),
  uuid: z.string().uuid().optional(),
});

/** Adds a particle effect to an animation, or replaces one with the same name at the same time. */
export const setParticleKeyframeOp = z.object({
  op: z.literal("set_particle_keyframe"),
  animation: z.string().min(1).describe("Animation UUID or name."),
  time: z.number().min(0),
  effect: z.string().min(1).describe("Effect name; the client entity's particle_effects map turns it into a particle identifier."),
  file: z.string().optional().describe("Particle JSON path, relative to the .bbmodel's folder (particles/smoke.json), so Blockbench previews the effect."),
  locator: z.string().min(1).optional().describe("Locator name the effect spawns at; omit for the entity origin."),
  pre_effect_script: z.string().optional().describe("Molang run before the emitter starts."),
  bind_to_actor: z.boolean().default(true).describe("Keep the emitter attached to the entity."),
});

/** Removes particle effects at a time, optionally only one effect name. */
export const removeParticleKeyframeOp = z.object({
  op: z.literal("remove_particle_keyframe"),
  animation: z.string().min(1),
  time: z.number().min(0),
  effect: z.string().min(1).optional().describe("Only this effect; omit to remove every effect at the time."),
});

/** What a particle operation did. */
interface IParticleOpResult {
  op: "add_locator" | "set_particle_keyframe" | "remove_particle_keyframe";
  uuid?: string;
  name?: string;
  detail?: string;
}

/** Locators saved in the document. */
export function locatorsOf(doc: IBBModel): IOtherElement[] {
  return doc.elements.filter((element): element is IOtherElement => element.type === "locator");
}

/**
 * Adds a locator element under a group (or the root).
 *
 * @throws Error when the name is taken or the parent group does not exist.
 */
export function applyAddLocator(doc: IBBModel, op: z.infer<typeof addLocatorOp>): [IBBModel, IParticleOpResult] {
  if (locatorsOf(doc).some((locator) => locator.name === op.name)) throw new Error(`A locator named ${op.name} already exists; locator names must be unique.`);
  const parent = op.parent ? resolveNode(indexModel(doc), op.parent, ["group"]).uuid : null;
  const uuid = freshUuid(doc, op.uuid);
  const locator: IOtherElement = {
    name: op.name,
    position: op.position,
    rotation: op.rotation ?? [0, 0, 0],
    ignore_inherited_scale: op.ignore_inherited_scale ?? false,
    visibility: true,
    locked: false,
    uuid,
    type: "locator",
  };
  return [{ ...doc, elements: [...doc.elements, locator], outliner: insertNode(doc.outliner, parent, uuid) }, { op: op.op, uuid, name: op.name }];
}

/** Replaces one animation in the document. */
function replaceAnimation(doc: IBBModel, updated: IAnimation): IBBModel {
  return { ...doc, animations: (doc.animations ?? []).map((entry) => (entry.uuid === updated.uuid ? updated : entry)) };
}

/** Rewrites the Effects track's keyframes. */
function withEffectKeys(animation: IAnimation, edit: (keys: IKeyframe[]) => IKeyframe[]): IAnimation {
  const track = animation.animators[EFFECTS_ANIMATOR_KEY] ?? { name: "Effects", type: "effect", keyframes: [] };
  return { ...animation, animators: { ...animation.animators, [EFFECTS_ANIMATOR_KEY]: { ...track, keyframes: edit(track.keyframes) } } };
}

const isParticleAt = (key: IKeyframe, time: number): boolean => key.channel === "particle" && Math.abs(key.time - time) < KEY_EPSILON;

/**
 * Adds a particle effect to an animation's Effects track, replacing the same effect at the same time.
 *
 * @throws Error when the locator or animation does not exist.
 */
export function applySetParticleKeyframe(doc: IBBModel, op: z.infer<typeof setParticleKeyframeOp>): [IBBModel, IParticleOpResult] {
  if (op.locator !== undefined && !locatorsOf(doc).some((locator) => locator.name === op.locator)) {
    throw new Error(`Locator ${op.locator} not found. Add it with add_locator first, or omit locator.`);
  }
  const animation = findAnimation(doc, op.animation);
  const point: DataPoint = { effect: op.effect, locator: op.locator ?? "", script: op.pre_effect_script ?? "", file: op.file ?? "", bind_to_actor: op.bind_to_actor };
  const uuid = crypto.randomUUID();
  const updated = withEffectKeys(animation, (keys) => {
    const existing = keys.find((key) => isParticleAt(key, op.time));
    if (!existing) {
      const created: IKeyframe = { channel: "particle", data_points: [point], uuid, time: op.time, color: -1, interpolation: "linear" };
      return [...keys, created].toSorted((a, b) => a.time - b.time);
    }
    const others = existing.data_points.filter((data) => data.effect !== op.effect);
    return keys.map((key) => (key === existing ? { ...key, data_points: [...others, point] } : key));
  });
  const late = op.time > animation.length ? ` (past the clip length ${animation.length}s)` : "";
  return [replaceAnimation(doc, updated), { op: op.op, name: animation.name, detail: `${op.effect} at ${op.time}s${late}` }];
}

/**
 * Removes particle effects at a time, dropping keyframes left empty.
 *
 * @throws Error when nothing matches.
 */
export function applyRemoveParticleKeyframe(doc: IBBModel, op: z.infer<typeof removeParticleKeyframeOp>): [IBBModel, IParticleOpResult] {
  const animation = findAnimation(doc, op.animation);
  const keys = animation.animators[EFFECTS_ANIMATOR_KEY]?.keyframes ?? [];
  const matches = (data: DataPoint): boolean => op.effect === undefined || data.effect === op.effect;
  const removed = keys.filter((key) => isParticleAt(key, op.time)).flatMap((key) => key.data_points.filter(matches)).length;
  if (removed === 0) throw new Error(`No particle effect${op.effect ? ` ${op.effect}` : ""} at ${op.time}s in ${animation.name}.`);
  const updated = withEffectKeys(animation, (current) => current.flatMap((key) => {
    if (!isParticleAt(key, op.time)) return [key];
    const kept = key.data_points.filter((data) => !matches(data));
    return kept.length ? [{ ...key, data_points: kept }] : [];
  }));
  return [replaceAnimation(doc, updated), { op: op.op, name: animation.name, detail: `removed ${removed}` }];
}
