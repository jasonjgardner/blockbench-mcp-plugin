/**
 * Minimal affine math for Blockbench transforms.
 *
 * Blockbench uses three.js Euler order `ZYX` for every node
 * (`ModelFormat.euler_order`), which composes as `Rz · Ry · Rx`. Rotations are
 * stored in degrees and applied about each node's `origin`. These helpers keep
 * that convention in one place so bounds, posing and gates agree.
 *
 * @module
 */

import type { Vec3 } from "../document/schema";

/** Row-major 3×3 matrix. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** Affine transform `p ↦ m·p + t`. */
export interface IAffine {
  readonly m: Mat3;
  readonly t: Vec3;
}

/** The identity matrix. */
export const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** The identity transform. */
export const IDENTITY: IAffine = { m: IDENTITY_MAT3, t: [0, 0, 0] };

const DEG = Math.PI / 180;

/** Multiplies two 3×3 matrices. */
export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const at = (row: number, col: number): number =>
    a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
  return [at(0, 0), at(0, 1), at(0, 2), at(1, 0), at(1, 1), at(1, 2), at(2, 0), at(2, 1), at(2, 2)];
}

/** Applies a 3×3 matrix to a vector. */
export function mulVec(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** Adds two vectors. */
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Subtracts `b` from `a`. */
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * Rotation matrix for Blockbench Euler angles in degrees (`Rz · Ry · Rx`).
 */
export function eulerZYX(degrees: Vec3): Mat3 {
  const [x, y, z] = degrees.map((value) => value * DEG) as unknown as Vec3;
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  const rx: Mat3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const ry: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rz: Mat3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mulMat3(rz, mulMat3(ry, rx));
}

/** Diagonal scale matrix. */
export function scaleMat(scale: Vec3): Mat3 {
  return [scale[0], 0, 0, 0, scale[1], 0, 0, 0, scale[2]];
}

/** Applies an affine transform to a point. */
export function apply(transform: IAffine, point: Vec3): Vec3 {
  return add(mulVec(transform.m, point), transform.t);
}

/** Composes transforms so that `compose(a, b)` applies `b` first, then `a`. */
export function compose(a: IAffine, b: IAffine): IAffine {
  return { m: mulMat3(a.m, b.m), t: add(mulVec(a.m, b.t), a.t) };
}

/**
 * Transform that rotates (and scales) about a pivot, then translates by `offset`:
 * `p ↦ pivot + offset + R·S·(p − pivot)`.
 */
export function aboutPivot(pivot: Vec3, rotation: Vec3, offset: Vec3 = [0, 0, 0], scale: Vec3 = [1, 1, 1]): IAffine {
  const m = mulMat3(eulerZYX(rotation), scaleMat(scale));
  return { m, t: sub(add(pivot, offset), mulVec(m, pivot)) };
}

/** Whether all three components are zero. */
export const isZero = (v: Vec3): boolean => v[0] === 0 && v[1] === 0 && v[2] === 0;
