/**
 * Vector math for the mesh library, mirroring the three.js calls Blockbench's
 * mesh code makes (`Vector3.cross`, `angleTo`, `Plane.projectPoint`,
 * `Spherical.setFromCartesianCoords`, `Euler` application, `Triangle.getUV`).
 *
 * Kept numerically close to three.js r129 (the version Blockbench bundles) so
 * ported algorithms land on the same numbers.
 *
 * @module
 */

import { add, sub } from "../geometry/math";
import type { Vec2, Vec3 } from "./types";

export { add, sub };

/** Scales a vector. */
export const scale = (v: Vec3, factor: number): Vec3 => [v[0] * factor, v[1] * factor, v[2] * factor];

/** Dot product. */
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Cross product `a × b`. */
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Euclidean length. */
export const length = (v: Vec3): number => Math.sqrt(dot(v, v));

/** Distance between two points. */
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

/**
 * Unit vector, or `[0, 0, 0]` for a zero vector. Matches `MeshFace.getNormal(true)`
 * (`dir / length || 0`) and three's `Vector3.normalize` on zero input.
 */
export const normalize = (v: Vec3): Vec3 => {
  const size = length(v);
  return [v[0] / size || 0, v[1] / size || 0, v[2] / size || 0];
};

/** Component-wise interpolation. */
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Average of points; `[0, 0, 0]` for an empty list. */
export const centroid = (points: readonly Vec3[]): Vec3 => {
  const sum = points.reduce<Vec3>((total, point) => add(total, point), [0, 0, 0]);
  return points.length ? scale(sum, 1 / points.length) : sum;
};

/** Angle between two vectors in degrees, like three's `Vector3.angleTo` (90 when either is zero). */
export function angleBetween(a: Vec3, b: Vec3): number {
  const denominator = Math.sqrt(dot(a, a) * dot(b, b));
  if (denominator === 0) return 90;
  const cosine = Math.min(1, Math.max(-1, dot(a, b) / denominator));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/**
 * Projects a point onto the plane through `planePoint` with `normal`
 * (three's `Plane.setFromNormalAndCoplanarPoint` + `projectPoint`). Like three,
 * the normal is used as given, not re-normalized.
 */
export function projectOntoPlane(point: Vec3, normal: Vec3, planePoint: Vec3): Vec3 {
  const constant = -dot(planePoint, normal);
  const signedDistance = dot(normal, point) + constant;
  return sub(point, scale(normal, signedDistance));
}

/** Signed distance of `point` from the plane through `planePoint` with (unnormalized) `normal`. */
export const planeDistance = (point: Vec3, normal: Vec3, planePoint: Vec3): number => dot(normal, point) - dot(planePoint, normal);

/**
 * Closest point to `point` on the infinite line through `start` and `end`
 * (three's `Line3.closestPointToPoint(point, false)`).
 */
export function closestPointOnLine(start: Vec3, end: Vec3, point: Vec3): Vec3 {
  const direction = sub(end, start);
  const t = dot(direction, sub(point, start)) / dot(direction, direction);
  return add(start, scale(direction, t));
}

const rotateX = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
};

const rotateY = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
};

const rotateZ = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
};

/**
 * Applies a three.js `Euler(x, y, z, 'XYZ')` rotation in radians to a vector,
 * i.e. `Rx · Ry · Rz · v`.
 */
export const applyEulerXYZ = (v: Vec3, x: number, y: number, z: number): Vec3 => rotateX(rotateY(rotateZ(v, z), y), x);

/**
 * Port of Blockbench `cameraTargetToRotation(position, target)` (util/util.js)
 * for `position = [0, 0, 0]`: the yaw/pitch pair (degrees) a camera needs to
 * look along `target`. Uses three's `Spherical.setFromCartesianCoords`.
 */
export function directionToRotation(target: Vec3): [number, number] {
  const [x, y, z] = target;
  const radius = Math.sqrt(x * x + y * y + z * z);
  const theta = radius === 0 ? 0 : Math.atan2(x, z);
  const phi = radius === 0 ? 0 : Math.acos(Math.min(1, Math.max(-1, y / radius)));
  const yaw = (-theta * 180) / Math.PI + 180;
  const pitchRaw = (-phi * 180) / Math.PI - 90;
  return [yaw, pitchRaw < 90 ? pitchRaw + 180 : pitchRaw];
}

/**
 * Barycentric coordinates of `point` in triangle `a b c` (three r129
 * `Triangle.getBarycoord`), or `undefined` for a degenerate triangle, where
 * three returns the sentinel `(-2, -1, -1)`.
 */
export function barycentric(point: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 | undefined {
  const v0 = sub(c, a);
  const v1 = sub(b, a);
  const v2 = sub(point, a);
  const dot00 = dot(v0, v0);
  const dot01 = dot(v0, v1);
  const dot02 = dot(v0, v2);
  const dot11 = dot(v1, v1);
  const dot12 = dot(v1, v2);
  const denominator = dot00 * dot11 - dot01 * dot01;
  if (denominator === 0) return undefined;
  const u = (dot11 * dot02 - dot01 * dot12) / denominator;
  const v = (dot00 * dot12 - dot01 * dot02) / denominator;
  return [1 - u - v, v, u];
}

/**
 * Interpolates UVs at `point` over triangle `a b c` (three r129 `Triangle.getUV`).
 * A degenerate triangle uses three's sentinel weights `(-2, -1, -1)` so results
 * match Blockbench even in that edge case.
 */
export function interpolateUv(point: Vec3, a: Vec3, b: Vec3, c: Vec3, uvA: Vec2, uvB: Vec2, uvC: Vec2): Vec2 {
  const [wa, wb, wc] = barycentric(point, a, b, c) ?? [-2, -1, -1];
  return [uvA[0] * wa + uvB[0] * wb + uvC[0] * wc, uvA[1] * wa + uvB[1] * wb + uvC[1] * wc];
}

/** Whether every component of a vector is a finite number. */
export const isFiniteVec = (v: readonly number[]): boolean => v.every((value) => Number.isFinite(value));
