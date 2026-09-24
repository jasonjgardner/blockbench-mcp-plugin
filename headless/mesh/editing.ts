/**
 * Basic mesh edits: vertex and face add/move/delete, transforms and winding.
 *
 * Vertex deletion ports the vertex branch of Blockbench's mesh `delete`
 * handler (js/modeling/mesh_editing.js, `SharedActions.add('delete')`); face
 * deletion ports its face branch; flipping ports `MeshFace.invert` as used by
 * the `invert_face` action. Moves and transforms are plain vertex arithmetic.
 *
 * @module
 */

import type { Vec3 } from "../document/schema";
import { aboutPivot, apply } from "../geometry/math";
import { MeshDraft } from "./draft";
import { angleToNormal, faceNormal, invertFace } from "./face";
import { faceAt, type IMeshGeometry, type MeshFaceData, vertexAt } from "./types";
import { add, isFiniteVec } from "./vector";

/** Throws unless every key names a vertex of the geometry. */
export function requireVertices(geometry: IMeshGeometry, keys: readonly string[]): void {
  const missing = keys.filter((key) => geometry.vertices[key] === undefined);
  if (missing.length) throw new Error(`Unknown vertex key(s): ${missing.join(", ")}.`);
}

/** Throws unless every key names a face of the geometry. */
export function requireFaces(geometry: IMeshGeometry, keys: readonly string[]): void {
  const missing = keys.filter((key) => geometry.faces[key] === undefined);
  if (missing.length) throw new Error(`Unknown face key(s): ${missing.join(", ")}.`);
}

/**
 * Validates one face against a geometry: 3 or 4 distinct existing vertices.
 * Blockbench's `getSortedVertices` only orders up to four corners, so larger
 * polygons are refused rather than silently mangled.
 */
export function validateFace(geometry: IMeshGeometry, face: MeshFaceData, label: string): void {
  const distinct = new Set(face.vertices);
  if (face.vertices.length < 3 || face.vertices.length > 4) throw new Error(`${label} has ${face.vertices.length} vertices; mesh faces need 3 or 4.`);
  if (distinct.size !== face.vertices.length) throw new Error(`${label} repeats a vertex; its vertices must be distinct.`);
  requireVertices(geometry, face.vertices);
  const badUv = Object.entries(face.uv).find(([, uv]) => !isFiniteVec(uv));
  if (badUv) throw new Error(`${label} has a non-finite UV for vertex ${badUv[0]}.`);
}

/**
 * Adds or replaces vertices by key.
 *
 * @throws Error when a position is not finite.
 */
export function setVertices(geometry: IMeshGeometry, vertices: Readonly<Record<string, Vec3>>): IMeshGeometry {
  const bad = Object.entries(vertices).find(([, v]) => !isFiniteVec(v));
  if (bad) throw new Error(`Vertex ${bad[0]} has a non-finite coordinate.`);
  return { ...geometry, vertices: { ...geometry.vertices, ...vertices } };
}

/** Moves vertices by an offset; `keys` omitted moves all of them. */
export function moveVertices(geometry: IMeshGeometry, offset: Vec3, keys?: readonly string[]): IMeshGeometry {
  const targets = new Set(keys ?? Object.keys(geometry.vertices));
  if (keys) requireVertices(geometry, keys);
  const vertices = Object.fromEntries(Object.entries(geometry.vertices).map(([key, v]) => [key, targets.has(key) ? add(v, offset) : v]));
  return { ...geometry, vertices };
}

/** Transform applied by {@link transformVertices}. */
export interface IVertexTransform {
  translate?: Vec3;
  /** Degrees, Blockbench Euler order ZYX (`Rz · Ry · Rx`). */
  rotate?: Vec3;
  scale?: Vec3;
  /** Pivot for rotate and scale, in the mesh's local space (default `[0, 0, 0]`, the mesh origin). */
  pivot?: Vec3;
}

/**
 * Scales, rotates about a pivot, then translates vertex positions:
 * `p ↦ pivot + translate + R·S·(p − pivot)`.
 */
export function transformVertices(geometry: IMeshGeometry, transform: IVertexTransform, keys?: readonly string[]): IMeshGeometry {
  if (keys) requireVertices(geometry, keys);
  const affine = aboutPivot(transform.pivot ?? [0, 0, 0], transform.rotate ?? [0, 0, 0], transform.translate ?? [0, 0, 0], transform.scale ?? [1, 1, 1]);
  const targets = new Set(keys ?? Object.keys(geometry.vertices));
  const vertices = Object.fromEntries(Object.entries(geometry.vertices).map(([key, v]) => [key, targets.has(key) ? apply(affine, v) : v]));
  return { ...geometry, vertices };
}

/**
 * Port of the vertex branch of Blockbench's mesh delete: each deleted vertex is
 * removed from its faces; a quad that becomes a triangle is re-inverted when
 * its normal flipped. Headless deviation: faces left with fewer than 3
 * vertices are dropped, where Blockbench keeps an uncovered 2-vertex edge.
 *
 * @throws Error for unknown keys, or when every vertex would be deleted (remove the element instead).
 */
export function deleteVertices(geometry: IMeshGeometry, keys: readonly string[]): IMeshGeometry {
  requireVertices(geometry, keys);
  if (new Set(keys).size >= Object.keys(geometry.vertices).length) throw new Error("Deleting every vertex would leave an empty mesh; remove the element instead.");
  const draft = MeshDraft.from(geometry);
  const lookup = (key: string): Vec3 => draft.vertex(key);
  keys.forEach((vertex) => {
    [...draft.faces.entries()].filter(([, face]) => face.vertices.includes(vertex)).forEach(([faceKey, face]) => {
      if (face.vertices.length <= 3) {
        draft.faces.delete(faceKey);
        return;
      }
      const initialNormal = faceNormal(lookup, face, false);
      const { [vertex]: _dropped, ...uv } = face.uv;
      const reduced: MeshFaceData = { ...face, vertices: face.vertices.filter((key) => key !== vertex), uv };
      draft.faces.set(faceKey, angleToNormal(lookup, reduced, initialNormal) > 90 ? invertFace(reduced) : reduced);
    });
    draft.vertices.delete(vertex);
  });
  return draft.toGeometry();
}

/**
 * Adds faces with fresh keys.
 *
 * @returns The new geometry and the created face keys, in input order.
 * @throws Error when a face fails {@link validateFace}.
 */
export function addFaces(geometry: IMeshGeometry, faces: readonly MeshFaceData[]): { geometry: IMeshGeometry; keys: string[] } {
  faces.forEach((face, index) => validateFace(geometry, face, `Face ${index + 1}`));
  const draft = MeshDraft.from(geometry);
  const keys = draft.addFaces(...faces);
  return { geometry: draft.toGeometry(), keys };
}

/**
 * Port of the face branch of Blockbench's mesh delete (without "keep
 * vertices"): removes the faces, then every vertex of theirs no other face uses.
 */
export function deleteFaces(geometry: IMeshGeometry, keys: readonly string[]): IMeshGeometry {
  requireFaces(geometry, keys);
  const doomed = new Set(keys);
  const affected = new Set(keys.flatMap((key) => faceAt(geometry, key).vertices));
  const faces = Object.fromEntries(Object.entries(geometry.faces).filter(([key]) => !doomed.has(key)));
  const used = new Set(Object.values(faces).flatMap((face) => face.vertices));
  const vertices = Object.fromEntries(Object.entries(geometry.vertices).filter(([key]) => !affected.has(key) || used.has(key)));
  return { vertices, faces };
}

/** Port of the `invert_face` action: reverses the winding of the faces (all when omitted); UVs stay with their vertices. */
export function flipFaces(geometry: IMeshGeometry, keys?: readonly string[]): IMeshGeometry {
  if (keys) requireFaces(geometry, keys);
  const targets = new Set(keys ?? Object.keys(geometry.faces));
  const faces = Object.fromEntries(Object.entries(geometry.faces).map(([key, face]) => [key, targets.has(key) ? invertFace(face) : face]));
  return { ...geometry, faces };
}

/** Throws when a vertex position is missing or non-finite (used after edits as a final guard). */
export function assertFiniteGeometry(geometry: IMeshGeometry): void {
  const bad = Object.keys(geometry.vertices).find((key) => !isFiniteVec(vertexAt(geometry, key)));
  if (bad) throw new Error(`Vertex ${bad} ended up with a non-finite coordinate.`);
}
