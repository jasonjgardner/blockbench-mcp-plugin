/**
 * World-space geometry of `.bbmodel` elements, in the bind pose or an animated pose.
 *
 * Taking min/max of a cube's `from`/`to` is wrong once rotations are involved: a
 * rotated cube or a cube under a rotated group occupies a different box. Every
 * measurement here applies the element's own rotation about its origin, then
 * each ancestor group's rotation about the group origin, the way Blockbench's
 * scene graph does.
 *
 * @module
 */

import { type IBBModel, type ICube, type IElement, isCube, isMesh, type Vec3 } from "../document/schema";
import { ancestorsOf, type IModelIndex } from "../document/tree";
import { aboutPivot, apply, compose, type IAffine, IDENTITY } from "./math";

/** Animated offsets for one group, added to its rest transform. */
export interface IBonePose {
  /** Degrees added to the group's rest rotation. */
  rotation: Vec3;
  /** Units added to the group's position. */
  position: Vec3;
  /** Multiplier on the group's scale. */
  scale: Vec3;
}

/** Pose offsets keyed by group UUID. Missing groups stay at rest. */
export type Pose = ReadonlyMap<string, IBonePose>;

/** An empty pose (the bind pose). */
export const REST_POSE: Pose = new Map();

/** Axis-aligned box. */
export interface IAabb {
  min: Vec3;
  max: Vec3;
}

/** Corners of a cube's box including inflate, in the cube's unrotated frame. */
export function cubeCorners(cube: ICube): Vec3[] {
  const inflate = cube.inflate ?? 0;
  const lo: Vec3 = [0, 1, 2].map((axis) => Math.min(cube.from[axis] ?? 0, cube.to[axis] ?? 0) - inflate) as unknown as Vec3;
  const hi: Vec3 = [0, 1, 2].map((axis) => Math.max(cube.from[axis] ?? 0, cube.to[axis] ?? 0) + inflate) as unknown as Vec3;
  return Array.from({ length: 8 }, (_, i): Vec3 => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
}

/** Points that define an element's shape before any rotation, or `[]` for non-geometric elements. */
export function elementLocalPoints(element: IElement): Vec3[] {
  if (isCube(element)) return cubeCorners(element);
  if (isMesh(element)) {
    return Object.values(element.vertices).map((v): Vec3 => [element.origin[0] + v[0], element.origin[1] + v[1], element.origin[2] + v[2]]);
  }
  return [];
}

/**
 * Computes group world transforms for a pose, memoized per call.
 *
 * @returns A function from group UUID to its world transform.
 */
export function groupTransforms(index: IModelIndex, pose: Pose = REST_POSE): (uuid: string | null) => IAffine {
  const cache = new Map<string, IAffine>();
  const transformOf = (uuid: string | null): IAffine => {
    if (uuid === null) return IDENTITY;
    const cached = cache.get(uuid);
    if (cached) return cached;
    const group = index.groups.get(uuid);
    const parent = index.placement.get(uuid)?.parent ?? null;
    const delta = pose.get(uuid);
    const rest = group?.rotation ?? [0, 0, 0];
    const rotation: Vec3 = delta ? [rest[0] + delta.rotation[0], rest[1] + delta.rotation[1], rest[2] + delta.rotation[2]] : rest;
    const local = aboutPivot(group?.origin ?? [0, 0, 0], rotation, delta?.position ?? [0, 0, 0], delta?.scale ?? [1, 1, 1]);
    const world = compose(transformOf(parent), local);
    cache.set(uuid, world);
    return world;
  };
  return transformOf;
}

/** An element's world-space points under `transforms`. */
export function elementWorldPoints(index: IModelIndex, element: IElement, transforms: (uuid: string | null) => IAffine): Vec3[] {
  const [parent = null] = ancestorsOf(index, element.uuid);
  if (!isCube(element) && !isMesh(element)) return [];
  const own = aboutPivot(element.origin, element.rotation ?? [0, 0, 0]);
  const world = compose(transforms(parent), own);
  return elementLocalPoints(element).map((point) => apply(world, point));
}

/** Smallest box around a set of points, or `undefined` for none. */
export function aabbOf(points: readonly Vec3[]): IAabb | undefined {
  const [first] = points;
  if (!first) return undefined;
  return points.reduce<IAabb>(
    (box, p) => ({
      min: [Math.min(box.min[0], p[0]), Math.min(box.min[1], p[1]), Math.min(box.min[2], p[2])],
      max: [Math.max(box.max[0], p[0]), Math.max(box.max[1], p[1]), Math.max(box.max[2], p[2])],
    }),
    { min: [...first], max: [...first] },
  );
}

/** Union of boxes, or `undefined` for none. */
export function unionAabb(boxes: readonly IAabb[]): IAabb | undefined {
  return aabbOf(boxes.flatMap((box) => [box.min, box.max]));
}

/** World-space box of every geometric element, keyed by UUID. */
export function elementBoxes(doc: IBBModel, index: IModelIndex, pose: Pose = REST_POSE, filter: (element: IElement) => boolean = () => true): Map<string, IAabb> {
  const transforms = groupTransforms(index, pose);
  return new Map(
    doc.elements
      .filter(filter)
      .flatMap((element) => {
        const box = aabbOf(elementWorldPoints(index, element, transforms));
        return box ? [[element.uuid, box] as const] : [];
      }),
  );
}

/** Per-axis overlap of two boxes; negative values are gaps. */
export function overlapPerAxis(a: IAabb, b: IAabb): Vec3 {
  return [0, 1, 2].map((axis) => Math.min(a.max[axis] ?? 0, b.max[axis] ?? 0) - Math.max(a.min[axis] ?? 0, b.min[axis] ?? 0)) as unknown as Vec3;
}

/** Size of a box. */
export function aabbSize(box: IAabb): Vec3 {
  return [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
}

/** Rounds for display. */
export const round = (value: number, digits = 3): number => Math.round(value * 10 ** digits) / 10 ** digits;

/** Rounds each component for display. */
export const roundVec = (v: readonly number[], digits = 3): number[] => v.map((value) => round(value, digits));
