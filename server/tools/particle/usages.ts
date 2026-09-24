/// <reference types="blockbench-types" />
/**
 * Finds where a project uses particle effects: particle keyframes on animation
 * Effects tracks and particles on animation controller states.
 *
 * @module
 */

import { getAnimationClass } from "@/server/tools/animation/shared";

/** One effect reference in a keyframe data point or controller state. */
export interface IParticleUsage {
  readonly source: "keyframe" | "controller_state";
  /** Animation or controller name. */
  readonly owner: string;
  readonly owner_uuid: string;
  /** Keyframe time, for keyframes. */
  readonly time?: number;
  /** State name, for controller states. */
  readonly state?: string;
  readonly keyframe_uuid?: string;
  readonly effect: string;
  /** Absolute path of the previewed effect file, when one is attached. */
  readonly file?: string;
  readonly locator?: string;
  readonly script?: string;
  readonly bind_to_actor: boolean;
}

/** A particle entry on a keyframe or controller state, as Blockbench stores it. */
interface IParticleDataPoint {
  effect?: string;
  file?: string;
  locator?: string;
  script?: string;
  pre_effect_script?: string;
  bind_to_actor?: boolean;
}

/** The parts of an animation controller state that hold particles. */
interface IControllerState {
  name: string;
  particles?: IParticleDataPoint[];
}

/** The parts of an animation controller the scan reads. */
interface IAnimationController {
  name: string;
  uuid: string;
  states: IControllerState[];
}

const text = (value: string | undefined): string | undefined => (value ? value : undefined);

/** Normalizes one stored particle entry. */
function usageFrom(point: IParticleDataPoint, base: Omit<IParticleUsage, "effect" | "file" | "locator" | "script" | "bind_to_actor">): IParticleUsage {
  return {
    ...base,
    effect: point.effect ?? "",
    file: text(point.file),
    locator: text(point.locator),
    script: text(point.script ?? point.pre_effect_script),
    bind_to_actor: point.bind_to_actor !== false,
  };
}

/** Particle keyframes of one animation, in time order. */
export function animationParticleUsages(animation: BBAnimation): IParticleUsage[] {
  const effects = animation.animators.effects as unknown as { particle?: BBKeyframe[] } | undefined;
  return [...(effects?.particle ?? [])]
    .toSorted((a, b) => a.time - b.time)
    .flatMap((keyframe) => (keyframe.data_points as unknown as IParticleDataPoint[]).map((point) => usageFrom(point, {
      source: "keyframe",
      owner: animation.name,
      owner_uuid: animation.uuid,
      time: keyframe.time,
      keyframe_uuid: keyframe.uuid,
    })));
}

/** Particles on animation controller states, when the format has controllers. */
function controllerUsages(): IParticleUsage[] {
  // @ts-ignore - AnimationController is a Blockbench global that published types omit
  const controllers = (typeof AnimationController === "undefined" ? [] : AnimationController.all ?? []) as IAnimationController[];
  return controllers.flatMap((controller) => controller.states.flatMap((state) => (state.particles ?? []).map((point) => usageFrom(point, {
    source: "controller_state",
    owner: controller.name,
    owner_uuid: controller.uuid,
    state: state.name,
  }))));
}

/** Every particle reference in the open project. */
export function projectParticleUsages(): IParticleUsage[] {
  return [...getAnimationClass().all.flatMap(animationParticleUsages), ...controllerUsages()];
}
