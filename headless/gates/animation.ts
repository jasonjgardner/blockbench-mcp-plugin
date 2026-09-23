/**
 * Animation gates: structural checks on keyframes and geometric checks on
 * sampled poses.
 *
 * The geometric gates follow bbmodel-maker's `animgate` principle: check the
 * keyframes the engine will play, sampled densely, rather than trusting the
 * curve the author intended. They are generic versions of that project's
 * species-specific gates:
 *
 * - `ground_sink`: during a clip, no part may sink below the lowest point of the
 *   rest pose by more than `sink_tolerance` (half a pixel by default: less is
 *   invisible, more reads as a foot in the floor).
 * - `detachment`: a group whose parts touch its parent group's parts at rest must
 *   not separate from them by more than `detach_gap` during a clip (a limb
 *   popping off its body).
 *
 * @module
 */

import type { IAnimation, IBBModel } from "../document/schema";
import { descendantsOf, directElementsOf, type IModelIndex, indexModel, nodeName } from "../document/tree";
import { elementBoxes, type IAabb, overlapPerAxis, type Pose, REST_POSE, round } from "../geometry/bounds";
import { emptySamplingNotes, type ISamplingNotes, MAX_SAMPLES_PER_CLIP, samplePose, sampleTimes } from "../geometry/pose";
import { gateResult, type IGateResult, type IGateViolation, skippedGate } from "./types";

/** Tunable thresholds for animation gates. */
export interface IAnimationGateOptions {
  /** Samples per second along each clip. */
  sampleRate: number;
  /** Allowed sink below the rest pose's lowest point, in units. */
  sinkTolerance: number;
  /** Ground height; `undefined` uses the lowest point of the rest pose. */
  groundY: number | undefined;
  /** Largest rest-pose gap that counts as "attached". */
  contactTolerance: number;
  /** Separation during a clip that counts as detachment. */
  detachGap: number;
  /** Clip names or UUIDs to check; empty checks all. */
  animations: readonly string[];
}

/** Default thresholds. */
export const DEFAULT_ANIMATION_OPTIONS: IAnimationGateOptions = {
  sampleRate: 20,
  sinkTolerance: 0.5,
  groundY: undefined,
  contactTolerance: 0.12,
  detachGap: 1,
  animations: [],
};

/** Result of the animation gates, including what could not be sampled. */
export interface IAnimationGateReport {
  results: IGateResult[];
  sampling: ISamplingNotes;
  /** Animations that were checked. */
  checked: string[];
}

/** Euclidean distance between two boxes (0 when they overlap). */
export function boxGap(a: IAabb, b: IAabb): number {
  return Math.hypot(...overlapPerAxis(a, b).map((overlap) => Math.max(0, -overlap)));
}

/** Smallest gap between any box of one set and any box of another. */
export function setGap(a: readonly IAabb[], b: readonly IAabb[]): number {
  return Math.min(Infinity, ...a.flatMap((boxA) => b.map((boxB) => boxGap(boxA, boxB))));
}

/** Keyframes for missing bones, out-of-range times, unknown channels, and duplicates. */
function gateStructure(animations: readonly IAnimation[], index: IModelIndex): IGateResult[] {
  const missingBones = animations.flatMap((animation) =>
    Object.entries(animation.animators)
      .filter(([id, animator]) => animator.type === "bone" && !index.groups.has(id))
      .map(([id, animator]) => ({ message: `${animation.name} animates ${animator.name || id}, which is not a group in this model.`, targets: [animator.name || id] })),
  );
  const keyIssues = animations.flatMap((animation) =>
    Object.entries(animation.animators).flatMap(([id, animator]) => {
      const bone = animator.name || id;
      const outOfRange = animator.keyframes
        .filter((key) => key.time < -1e-6 || (animation.length > 0 && key.time > animation.length + 1e-6))
        .map((key) => ({ message: `${animation.name} / ${bone}: ${key.channel} keyframe at ${key.time}s is outside 0…${animation.length}s.`, targets: [bone] }));
      const grouped = Map.groupBy(animator.keyframes, (key) => `${key.channel}@${round(key.time, 4)}`);
      const duplicates = [...grouped].filter(([, keys]) => keys.length > 1).map(([slot, keys]) => ({
        message: `${animation.name} / ${bone}: ${keys.length} keyframes share ${slot.replace("@", " at ")}s.`,
        targets: [bone],
      }));
      return [...outOfRange, ...duplicates];
    }),
  );
  return [
    gateResult("animated_bones_exist", "Animators target groups that exist", "error", missingBones),
    gateResult("keyframe_timing", "Keyframes lie inside the clip and do not collide", "warning", keyIssues),
  ];
}

/** Lowest world Y of all geometry under a pose. */
function lowestY(doc: IBBModel, index: IModelIndex, pose: Pose): { y: number; name: string } {
  const boxes = elementBoxes(doc, index, pose, (element) => index.placement.has(element.uuid));
  return [...boxes].reduce((lowest, [uuid, box]) => (box.min[1] < lowest.y ? { y: box.min[1], name: nodeName(index, uuid) } : lowest), { y: Infinity, name: "" });
}

/** Parts sinking below the ground during a clip. */
function gateGroundSink(doc: IBBModel, index: IModelIndex, animations: readonly IAnimation[], options: IAnimationGateOptions, notes: ISamplingNotes): IGateResult {
  const label = "No part sinks below the ground during a clip";
  const rest = lowestY(doc, index, REST_POSE);
  if (!Number.isFinite(rest.y)) return skippedGate("ground_sink", label, "warning", "The model has no geometry.");
  const ground = options.groundY ?? rest.y;
  const violations = animations.flatMap((animation): IGateViolation[] => {
    const worst = sampleTimes(animation.length, options.sampleRate)
      .map((time) => ({ time, ...lowestY(doc, index, samplePose(animation, time, notes)) }))
      .reduce((a, b) => (b.y < a.y ? b : a));
    const sink = ground - worst.y;
    if (sink <= options.sinkTolerance) return [];
    return [{ message: `${animation.name}: ${worst.name} sinks ${round(sink, 2)} units below ground y=${round(ground, 2)} at ${round(worst.time, 3)}s.`, targets: [worst.name] }];
  });
  return gateResult("ground_sink", label, "warning", violations);
}

/** Groups separating from their parent group during a clip. */
function gateDetachment(doc: IBBModel, index: IModelIndex, animations: readonly IAnimation[], options: IAnimationGateOptions, notes: ISamplingNotes): IGateResult {
  const label = "Attached groups stay attached to their parent during a clip";
  const boxesFor = (pose: Pose) => elementBoxes(doc, index, pose, (element) => index.placement.has(element.uuid));
  const subtreeElements = (groupUuid: string): string[] => [...directElementsOf(index, groupUuid), ...descendantsOf(index, groupUuid).filter((id) => index.elements.has(id))];
  const restBoxes = boxesFor(REST_POSE);
  const pick = (boxes: Map<string, IAabb>, ids: readonly string[]): IAabb[] => ids.flatMap((id) => boxes.get(id) ?? []);
  const pairs = [...index.groups.keys()].flatMap((groupUuid) => {
    const parent = index.placement.get(groupUuid)?.parent ?? null;
    if (parent === null) return [];
    const own = [...new Set(subtreeElements(groupUuid))];
    const parentOwn = directElementsOf(index, parent);
    if (own.length === 0 || parentOwn.length === 0) return [];
    const restGap = setGap(pick(restBoxes, own), pick(restBoxes, parentOwn));
    return restGap <= options.contactTolerance ? [{ groupUuid, parent, own, parentOwn }] : [];
  });
  if (pairs.length === 0) return skippedGate("detachment", label, "warning", "No group touches geometry of its parent group at rest.");
  const violations = animations.flatMap((animation) => {
    const samples = sampleTimes(animation.length, options.sampleRate).map((time) => ({ time, boxes: boxesFor(samplePose(animation, time, notes)) }));
    return pairs.flatMap((pair): IGateViolation[] => {
      const worst = samples
        .map(({ time, boxes }) => ({ time, gap: setGap(pick(boxes, pair.own), pick(boxes, pair.parentOwn)) }))
        .reduce((a, b) => (b.gap > a.gap ? b : a));
      if (worst.gap <= options.detachGap) return [];
      const child = nodeName(index, pair.groupUuid);
      const parent = nodeName(index, pair.parent);
      return [{ message: `${animation.name}: ${child} separates ${round(worst.gap, 2)} units from ${parent} at ${round(worst.time, 3)}s.`, targets: [child, parent] }];
    });
  });
  return gateResult("detachment", label, "warning", violations);
}

/**
 * Runs animation gates.
 *
 * @returns Gate results, the clips checked, and channels the sampler skipped or approximated.
 */
export function runAnimationGates(doc: IBBModel, options: Partial<IAnimationGateOptions> = {}): IAnimationGateReport {
  const settings = { ...DEFAULT_ANIMATION_OPTIONS, ...options };
  const index = indexModel(doc);
  const all = doc.animations ?? [];
  const animations = settings.animations.length === 0 ? all : all.filter((a) => settings.animations.includes(a.name) || settings.animations.includes(a.uuid));
  const notes: ISamplingNotes = {
    ...emptySamplingNotes(),
    cappedClips: animations.filter((animation) => animation.length * settings.sampleRate > MAX_SAMPLES_PER_CLIP).map((animation) => animation.name),
  };
  if (animations.length === 0) {
    const reason = all.length === 0 ? "The model has no animations." : `No animation matches ${settings.animations.join(", ")}.`;
    return { results: [skippedGate("animations", "Animation checks", "warning", reason)], sampling: notes, checked: [] };
  }
  const results = [
    ...gateStructure(animations, index),
    gateGroundSink(doc, index, animations, settings, notes),
    gateDetachment(doc, index, animations, settings, notes),
  ];
  return { results, sampling: notes, checked: animations.map((a) => a.name) };
}
