/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { shortNameOf } from "@/lib/particles/build";
import { findGroupOrThrow } from "@/lib/util";
import { runUndoableAnimationEdit } from "@/lib/animation-undo";
import { animationToolDocs } from "./docs";
import { createAnimationParameters } from "./schemas";
import { TRANSFORM_CHANNELS, applyKeyframeValues, getAnimationClass, requireBoneAnimator } from "./shared";

type CreateAnimationInput = z.infer<typeof createAnimationParameters>;
type BoneKeyframeInput = CreateAnimationInput["bones"][string][number];

/** Keyframes requested for one existing bone, resolved before the undo edit starts. */
interface IBoneKeyframeTarget {
  group: Group;
  keyframes: BoneKeyframeInput[];
}

/** A particle effect scheduled at a validated, nonnegative time in seconds. */
interface IParticleKeyframe {
  time: number;
  effect: string;
}

/** Fully validated creation request; building from it cannot fail on input. */
interface IValidatedAnimationInput {
  targets: IBoneKeyframeTarget[];
  particles: IParticleKeyframe[];
  latestTime: number;
}

/**
 * Rejects two keyframes on the same channel at the same time for one bone,
 * reporting the first repeat in request order.
 * @throws When a channel/time pair repeats.
 */
function assertUniqueChannelTimes(boneName: string, keyframes: BoneKeyframeInput[]): void {
  const entries = keyframes.flatMap((frame) => TRANSFORM_CHANNELS
    .filter((channel) => frame[channel] !== undefined)
    .map((channel) => ({ channel, time: frame.time, key: `${channel}:${frame.time}` })));
  const keys = entries.map(({ key }) => key);
  if (new Set(keys).size === keys.length) return;
  const duplicate = entries.find(({ key }, index) => keys.indexOf(key) !== index);
  if (duplicate) throw new Error(`Duplicate ${duplicate.channel} keyframe at ${duplicate.time} seconds for "${boneName}".`);
}

/**
 * Parses particle timestamps from their record keys.
 * @throws When a key is blank, non-finite, or negative.
 */
function parseParticleKeyframes(particleEffects: Record<string, string> | undefined): IParticleKeyframe[] {
  return Object.entries(particleEffects ?? {}).map(([timestamp, effect]) => {
    const time = Number(timestamp);
    if (!timestamp.trim() || !Number.isFinite(time) || time < 0) {
      throw new Error(`Invalid particle timestamp "${timestamp}"; use nonnegative seconds.`);
    }
    return { time, effect };
  });
}

/**
 * Validates every bone, keyframe, and particle before Undo is touched, so an
 * invalid request leaves both the project and its history unchanged.
 * @throws For missing bones, duplicate channel times, bad particle timestamps,
 *   or an `animation_length` shorter than the last keyframe.
 */
function validateAnimationInput({ animation_length, bones, particle_effects }: CreateAnimationInput): IValidatedAnimationInput {
  const targets = Object.entries(bones).map(([boneName, keyframes]) => {
    const group = findGroupOrThrow(boneName);
    assertUniqueChannelTimes(boneName, keyframes);
    return { group, keyframes };
  });
  const particles = parseParticleKeyframes(particle_effects);
  const latestTime = Math.max(0, ...targets.flatMap(({ keyframes }) => keyframes.map(({ time }) => time)), ...particles.map(({ time }) => time));
  if (animation_length !== undefined && animation_length < latestTime) {
    throw new Error(`animation_length must include the last keyframe at ${latestTime} seconds.`);
  }
  return { targets, particles, latestTime };
}

/** Writes one requested time's transform channels as linear keyframes. */
function addBoneKeyframes(animator: BoneAnimator, data: BoneKeyframeInput): void {
  TRANSFORM_CHANNELS.forEach((channel) => {
    const values = data[channel];
    if (values === undefined) return;
    const keyframe = animator.addKeyframe({
      time: data.time, channel, interpolation: "linear", data_points: [{}],
    });
    applyKeyframeValues(keyframe, values);
  });
}

/**
 * Path of a loaded particle effect named by `effect` (identifier, short name or
 * path), so the keyframe previews like one added by manage_particle_keyframes.
 * Deliberately simpler than the particle tools' lookup: it needs no native
 * `path` module and never throws, so create_animation keeps working (without a
 * preview) when a name is ambiguous or unknown.
 */
function loadedParticleFile(effect: string): string | undefined {
  const loaded = (Animator as unknown as { particle_effects?: Record<string, { config?: { identifier?: string } }> }).particle_effects ?? {};
  return Object.entries(loaded).find(([path, entry]) => {
    const identifier = entry.config?.identifier ?? "";
    return path === effect || identifier === effect || (identifier !== "" && shortNameOf(identifier) === effect);
  })?.[0];
}

/** Adds an effects animator carrying particle keyframes, when any were requested. */
function addParticleKeyframes(animation: BBAnimation, particles: IParticleKeyframe[]): void {
  if (!particles.length) return;
  const effects = new EffectAnimator(animation);
  animation.animators.effects = effects;
  particles.forEach(({ time, effect }) => {
    const file = loadedParticleFile(effect);
    effects.addKeyframe({ time, channel: "particle", data_points: [{ effect, ...(file ? { file } : {}) }] });
  });
}

/** Populates a new animation with validated bone and particle keyframes. */
function buildAnimationKeyframes(animation: BBAnimation, { targets, particles }: IValidatedAnimationInput): void {
  targets.forEach(({ group, keyframes }) => {
    const animator = requireBoneAnimator(animation, group);
    keyframes.forEach((data) => addBoneKeyframes(animator, data));
  });
  addParticleKeyframes(animation, particles);
}

/**
 * Registers `create_animation`, which builds and selects a new animation in a
 * single undo entry. Call only after Blockbench globals exist.
 */
export function registerCreateAnimationTool(): void {
  createTool(
    animationToolDocs[0].name,
    {
      ...animationToolDocs[0],
      parameters: createAnimationParameters,
      async execute(input) {
        if (!Project || !Format.animation_mode) {
          throw new Error("The current project format does not support animations. Use get_capabilities to inspect supported formats.");
        }
        const validated = validateAnimationInput(input);
        const animations: BBAnimation[] = [];
        const animation = runUndoableAnimationEdit({ animations }, "Create animation", () => {
          const AnimationClass = getAnimationClass();
          const created = new AnimationClass({
            name: `animation.${input.name}`, loop: input.loop ? "loop" : "once",
            length: input.animation_length ?? validated.latestTime,
          });
          animations.push(created);
          created.add(false);
          buildAnimationKeyframes(created, validated);
          created.select();
          Animator.preview();
          return created;
        });
        return JSON.stringify({ uuid: animation.uuid, name: animation.name, length: animation.length, loop: animation.loop, bones: validated.targets.length });
      },
    },
    animationToolDocs[0].status
  );
}
