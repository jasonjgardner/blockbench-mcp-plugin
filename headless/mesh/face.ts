/**
 * Ports of Blockbench's `MeshFace` geometry methods (js/outliner/types/mesh.js).
 *
 * Blockbench faces have 2 to 4 vertices. Quads are stored in any order and
 * `getSortedVertices` recovers the perimeter order, which every edit and the
 * normal calculation rely on. These functions take a vertex lookup so they work
 * on both frozen geometries and {@link MeshDraft} working copies.
 *
 * @module
 */

import type { IMeshGeometry, MeshFaceData, Vec2, Vec3 } from "./types";
import { uvOf, vertexAt } from "./types";
import { angleBetween, closestPointOnLine, cross, interpolateUv, normalize, planeDistance, sub } from "./vector";

/** Resolves a vertex key to its position. */
export type VertexLookup = (key: string) => Vec3;

/** A lookup over a frozen geometry. */
export const lookupIn = (geometry: IMeshGeometry): VertexLookup => (key) => vertexAt(geometry, key);

/**
 * Whether `check` lies on the other side of the line `base1`–`base2` than `top`
 * (the inner `test` of `MeshFace.getSortedVertices`).
 */
function acrossLine(base1: Vec3, base2: Vec3, top: Vec3, check: Vec3): boolean {
  const normal = sub(closestPointOnLine(base1, base2, top), top);
  return planeDistance(check, normal, base2) > 0;
}

/**
 * Port of `MeshFace.getSortedVertices`: the quad's vertices in perimeter order.
 * Triangles and edges are returned unchanged.
 */
export function sortedVertices(lookup: VertexLookup, face: MeshFaceData): string[] {
  const keys = face.vertices;
  if (keys.length < 4) return [...keys];
  const [k0, k1, k2, k3] = keys as [string, string, string, string];
  const [p0, p1, p2, p3] = [lookup(k0), lookup(k1), lookup(k2), lookup(k3)];
  if (acrossLine(p1, p2, p0, p3)) return [k2, k0, k1, k3];
  if (acrossLine(p0, p1, p2, p3)) return [k0, k2, k1, k3];
  return [...keys];
}

/**
 * Port of `MeshFace.getNormal(normalize)`: cross product of the first two
 * sorted edges from the first sorted vertex; `[0, 0, 0]` below 3 vertices.
 */
export function faceNormal(lookup: VertexLookup, face: MeshFaceData, unit = true): Vec3 {
  const sorted = sortedVertices(lookup, face);
  if (sorted.length < 3) return [0, 0, 0];
  const [k0, k1, k2] = sorted as [string, string, string];
  const base = lookup(k0);
  const direction = cross(sub(lookup(k1), base), sub(lookup(k2), base));
  return unit ? normalize(direction) : direction;
}

/** Port of `MeshFace.getAngleTo`: degrees between this face's normal and another normal. */
export const angleToNormal = (lookup: VertexLookup, face: MeshFaceData, other: Vec3): number => angleBetween(faceNormal(lookup, face, false), other);

/** Port of `MeshFace.invert`: swaps the first two vertices, flipping the winding. UVs stay with their vertices. */
export function invertFace(face: MeshFaceData): MeshFaceData {
  if (face.vertices.length < 3) return face;
  const [a, b, ...rest] = face.vertices as [string, string, ...string[]];
  return { ...face, vertices: [b, a, ...rest] };
}

/** Port of `MeshFace.getEdges`: perimeter edges in sorted order. */
export function faceEdges(lookup: VertexLookup, face: MeshFaceData): [string, string][] {
  const sorted = sortedVertices(lookup, face);
  if (sorted.length === 2) return [sorted as [string, string]];
  if (sorted.length < 2) return [];
  return sorted.map((key, index) => [key, sorted[index + 1] ?? (sorted[0] as string)]);
}

/** Port of `MeshFace.getCenter`: the mean of the face's vertex positions. */
export function faceCenter(lookup: VertexLookup, face: MeshFaceData): Vec3 {
  const sum = face.vertices.reduce<Vec3>((total, key) => {
    const p = lookup(key);
    return [total[0] + p[0], total[1] + p[1], total[2] + p[2]];
  }, [0, 0, 0]);
  const count = face.vertices.length || 1;
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}

/**
 * Port of `MeshFace.localToUV(vector)`: interpolates the face's UV at a local
 * point using the triangle of its first three stored (unsorted) vertices.
 */
export function localToUv(lookup: VertexLookup, face: MeshFaceData, point: Vec3): Vec2 {
  const [a, b, c] = face.vertices as [string, string, string];
  return interpolateUv(point, lookup(a), lookup(b), lookup(c), uvOf(face, a), uvOf(face, b), uvOf(face, c));
}

/** Edge identity independent of direction (`sameMeshEdge` in js/modeling/mesh/util.ts). */
export const sameEdge = (a: readonly string[], b: readonly string[]): boolean => (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
