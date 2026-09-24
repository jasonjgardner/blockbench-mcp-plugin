/// <reference types="blockbench-types" />
import type { z } from "zod";
import { runUndoableAnimationEdit } from "@/lib/animation-undo";
import { createTool } from "@/lib/factories";
import { shortNameOf } from "@/lib/particles/build";
import { animationTriggerWarning } from "@/lib/particles/validate";
import { createJsonResult } from "@/lib/tool-results";
import { runUndoableEdit } from "@/lib/undo";
import { findAnimationOrSelected, KEYFRAME_TIME_EPSILON } from "@/server/tools/animation/shared";
import { particleToolDocs } from "./docs";
import { findLoadedEffect, particleFs, particlePath, resolveEffect } from "./host";
import type { addLocatorParameters, manageParticleKeyframesParameters } from "./schemas";
import { animationParticleUsages } from "./usages";

type ManageInput = z.infer<typeof manageParticleKeyframesParameters>;
type KeyframeInput = NonNullable<ManageInput["keyframes"]>[number];
type LocatorInput = z.infer<typeof addLocatorParameters>;

const spec = (name: string) => {
  const found = particleToolDocs.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing particle tool spec ${name}.`);
  return found;
};

/** What a particle keyframe data point stores. */
interface IParticlePoint {
  effect: string;
  file: string;
  locator: string;
  script: string;
  bind_to_actor: boolean;
}

/** The Effects track members this tool touches; published types omit them. */
interface IEffectTrack {
  particle: BBKeyframe[];
  addKeyframe(data: { time: number; channel: string; data_points: IParticlePoint[] }): BBKeyframe;
}

/** Native keyframe removal, which published types omit. */
interface IRemovableKeyframe {
  remove(): void;
}

/** Resolves the effect a keyframe asks for; unknown names are allowed (GeckoLib handlers) but have no preview. */
function resolvePoint(input: KeyframeInput): { point: IParticlePoint; previewed: boolean; looping: boolean } {
  const path = particlePath();
  const loaded = findLoadedEffect(input.effect) ?? (path.isAbsolute(input.effect) ? resolveEffect(particleFs(`MCP manage_particle_keyframes loads ${input.effect}`), input.effect) : undefined);
  const identifier = loaded?.effect.config.identifier;
  const name = input.effect_name ?? (identifier ? shortNameOf(identifier) : input.effect);
  return {
    point: { effect: name, file: loaded?.path ?? "", locator: input.locator ?? "", script: input.pre_effect_script ?? "", bind_to_actor: input.bind_to_actor },
    previewed: loaded !== undefined,
    looping: loaded?.effect.config.emitter_lifetime_mode === "looping",
  };
}

/** Rejects locators that do not exist, since the game would silently fall back to the entity origin. */
function assertLocators(keyframes: readonly KeyframeInput[]): void {
  const names = new Set(Locator.all.map((locator) => locator.name));
  const missing = [...new Set(keyframes.map((frame) => frame.locator).filter((name): name is string => name !== undefined && !names.has(name)))];
  if (missing.length) throw new Error(`Locator ${missing.join(", ")} not found. Create it with add_locator, or omit locator to spawn at the entity origin.`);
}

/** The animation's Effects track, created on demand. */
function effectTrack(animation: BBAnimation): IEffectTrack {
  const existing = animation.animators.effects as unknown as IEffectTrack | undefined;
  if (existing) return existing;
  const created = new EffectAnimator(animation);
  animation.animators.effects = created;
  return created as unknown as IEffectTrack;
}

function addKeyframes(animation: BBAnimation, keyframes: readonly KeyframeInput[]): Record<string, unknown> {
  if (!keyframes.length) throw new Error("add needs keyframes.");
  const late = keyframes.filter((frame) => frame.time > animation.length + KEYFRAME_TIME_EPSILON);
  if (late.length) throw new Error(`Keyframe time ${late.map((frame) => frame.time).join(", ")}s is past the animation length ${animation.length}s. Lengthen it with animation_timeline set_length first.`);
  assertLocators(keyframes);
  const resolved = keyframes.map((frame) => ({ time: frame.time, ...resolvePoint(frame) }));
  runUndoableAnimationEdit({ animations: [animation] }, "Add particle keyframes", () => {
    const track = effectTrack(animation);
    resolved.forEach(({ time, point }) => {
      const shared = track.particle.find((keyframe) => Math.abs(keyframe.time - time) < KEYFRAME_TIME_EPSILON);
      if (!shared) {
        track.addKeyframe({ time, channel: "particle", data_points: [point] });
        return;
      }
      const dataPoint = new KeyframeDataPoint(shared);
      dataPoint.extend({ ...point });
      shared.data_points.push(dataPoint);
    });
  });
  Animator.preview();
  const unpreviewed = [...new Set(resolved.filter((entry) => !entry.previewed).map((entry) => entry.point.effect))];
  const looping = [...new Set(resolved.filter((entry) => entry.looping).map((entry) => entry.point.effect))];
  const warnings = [
    ...(unpreviewed.length ? [`No loaded particle file for ${unpreviewed.join(", ")}: the keyframe exports, but Blockbench shows nothing. Create the effect with create_particle_effect or pass its file path.`] : []),
    ...looping.flatMap((name) => animationTriggerWarning(name, true, animation.length) ?? []),
  ];
  return {
    added: resolved.length,
    keyframes: animationParticleUsages(animation),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Whether a stored data point matches a remove filter by name, identifier or file. */
function pointMatches(point: { effect?: string; file?: string }, filter: string | undefined): boolean {
  if (filter === undefined) return true;
  const loaded = point.file ? findLoadedEffect(point.file) : undefined;
  return point.effect === filter || point.file === filter || loaded?.effect.config.identifier === filter;
}

function removeKeyframes(animation: BBAnimation, times: readonly number[] | undefined, filter: string | undefined): Record<string, unknown> {
  const track = animation.animators.effects as unknown as IEffectTrack | undefined;
  const atTime = (keyframe: BBKeyframe): boolean => times === undefined || times.some((time) => Math.abs(keyframe.time - time) < KEYFRAME_TIME_EPSILON);
  const targets = (track?.particle ?? []).filter(atTime);
  const matching = targets.filter((keyframe) => (keyframe.data_points as unknown as { effect?: string; file?: string }[]).some((point) => pointMatches(point, filter)));
  if (!matching.length) throw new Error("No particle keyframes match. List them with action: list.");
  const removed = runUndoableAnimationEdit({ animations: [animation] }, "Remove particle keyframes", () => matching.reduce((count, keyframe) => {
    const points = keyframe.data_points as unknown as { effect?: string; file?: string }[];
    const keep = points.filter((point) => !pointMatches(point, filter));
    const dropped = points.length - keep.length;
    if (keep.length === 0) {
      (keyframe as unknown as IRemovableKeyframe).remove();
      return count + dropped;
    }
    // Splicing in place keeps Blockbench's references to the data point array valid.
    keyframe.data_points.splice(0, Infinity, ...(keep as never[]));
    return count + dropped;
  }, 0));
  Animator.preview();
  return { removed, keyframes: animationParticleUsages(animation) };
}

function registerManageKeyframes(): void {
  const docs = spec("manage_particle_keyframes");
  createTool(docs.name, {
    ...docs,
    async execute({ animation_id, action, keyframes, times, effect_filter }: ManageInput) {
      const animation = findAnimationOrSelected(animation_id);
      if (!animation) throw new Error(animation_id ? `Animation "${animation_id}" not found.` : "No animation is selected. Pass animation_id or create one with create_animation.");
      if (action === "list") return createJsonResult({ animation: animation.name, length: animation.length, keyframes: animationParticleUsages(animation) });
      if (action === "remove") return createJsonResult(removeKeyframes(animation, times, effect_filter));
      return createJsonResult(addKeyframes(animation, keyframes ?? []));
    },
  }, docs.status);
}

/** Finds a group by UUID or name. */
function findParentGroup(reference: string): Group {
  const group = Group.all.find((candidate) => candidate.uuid === reference) ?? Group.all.find((candidate) => candidate.name === reference);
  if (!group) throw new Error(`Bone/group "${reference}" not found. Use list_outline to see bones.`);
  return group;
}

function registerAddLocator(): void {
  const docs = spec("add_locator");
  createTool(docs.name, {
    ...docs,
    async execute({ name, parent, position, rotation, ignore_inherited_scale }: LocatorInput) {
      if (Locator.all.some((locator) => locator.name === name)) throw new Error(`A locator named "${name}" already exists; locator names must be unique.`);
      const group = parent === undefined ? undefined : findParentGroup(parent);
      const locator = new Locator({ name, position, ...(rotation ? { rotation } : {}), ...(ignore_inherited_scale === undefined ? {} : { ignore_inherited_scale }) } as never);
      runUndoableEdit({ outliner: true, elements: [] }, "Add locator", () => {
        locator.addTo(group ?? "root");
        locator.init();
      }, { outliner: true, elements: [locator] });
      Canvas.updateAll();
      return createJsonResult({
        uuid: locator.uuid,
        name: locator.name,
        parent: group?.name ?? null,
        position,
        ...(rotation ? { rotation } : {}),
      });
    },
  }, docs.status);
}

/** Registers the keyframe and locator tools. */
export function registerParticleKeyframeTools(): void {
  registerManageKeyframes();
  registerAddLocator();
}
