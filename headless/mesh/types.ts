/**
 * Shared shapes and small helpers for the headless mesh library.
 *
 * Blockbench stores a mesh as two keyed maps: `vertices` (4-character keys to
 * `[x, y, z]` positions relative to the mesh origin) and `faces` (8-character
 * keys to `{vertices, uv, texture}`). The library works on exactly that data
 * so results can be written back into a `.bbmodel` without conversion.
 *
 * Every public function takes an {@link IMeshGeometry} and returns a new one;
 * inputs are never mutated.
 *
 * @module
 */

import type { IMesh, Vec2, Vec3 } from "../document/schema";

/** One saved mesh face: vertex keys, per-vertex UVs, optional texture, plus any passthrough fields. */
export type MeshFaceData = IMesh["faces"][string];

/**
 * The editable part of a mesh: vertex positions (local, before rotation) and
 * faces. Key order follows insertion, like Blockbench's plain objects.
 */
export interface IMeshGeometry {
  readonly vertices: Readonly<Record<string, Vec3>>;
  readonly faces: Readonly<Record<string, MeshFaceData>>;
}

/** An empty geometry, the starting point for builders. */
export const EMPTY_GEOMETRY: IMeshGeometry = { vertices: {}, faces: {} };

/** `[u, v]` pair, re-exported for callers that only import this module. */
export type { Vec2, Vec3 };

/** Width and height of the UV space a face maps into (project resolution or the face texture's uv size). */
export type UvSize = readonly [number, number];

/** Rounds like Blockbench's `Math.roundTo` (util/math_util.js). */
export const roundTo = (value: number, digits: number): number => {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
};

/** Linear interpolation like Blockbench's `Math.lerp`. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Clamps like Blockbench's `Math.clamp`. */
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Looks up a vertex position.
 *
 * @throws Error naming the missing key, so a stale key never turns into NaN geometry.
 */
export function vertexAt(geometry: IMeshGeometry, key: string): Vec3 {
  const position = geometry.vertices[key];
  if (!position) throw new Error(`Vertex ${key} does not exist in this mesh.`);
  return position;
}

/**
 * Looks up a face.
 *
 * @throws Error naming the missing key.
 */
export function faceAt(geometry: IMeshGeometry, key: string): MeshFaceData {
  const face = geometry.faces[key];
  if (!face) throw new Error(`Face ${key} does not exist in this mesh.`);
  return face;
}

/** Vertex and face counts, used in operation detail strings. */
export function countsOf(geometry: IMeshGeometry): { vertices: number; faces: number } {
  return { vertices: Object.keys(geometry.vertices).length, faces: Object.keys(geometry.faces).length };
}

/** Per-vertex UV of a face, `[0, 0]` when the face has none (MeshFace.extend's default). */
export const uvOf = (face: MeshFaceData, key: string): Vec2 => face.uv[key] ?? [0, 0];
