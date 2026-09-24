/**
 * Port of Blockbench's "Merge Vertices › By Distance" (`mergeVertices(true, in_center)`
 * in js/modeling/mesh/merge_split.ts) and `cleanupOverlappingMeshFaces`.
 *
 * Vertices are grouped greedily in key order: the first unconsumed vertex
 * collects every later vertex closer than `distance` (strict `<`, like
 * Blockbench's `vertex_merge_distance` setting, default 0.1). Each group
 * collapses into its first vertex (or their centroid with `inCenter`). Faces
 * that already hold the survivor drop the merged vertex; others swap it for
 * the survivor and keep its UV. Afterwards faces with fewer than 2 vertices,
 * and faces whose vertices all lie inside another face, are removed.
 *
 * @module
 */

import { MeshDraft } from "./draft";
import type { IMeshGeometry, MeshFaceData, Vec2 } from "./types";
import { centroid, distance as distanceBetween } from "./vector";
import { requireVertices } from "./editing";

/** Blockbench's default `vertex_merge_distance` setting (js/interface/setup_settings.js). */
export const DEFAULT_MERGE_DISTANCE = 0.1;

/** What a merge did, in Blockbench's "merged {found} vertices into {result}" terms. */
export interface IMergeResult {
  geometry: IMeshGeometry;
  /** Vertices involved in merges (every member of every group). */
  found: number;
  /** Groups merged (surviving vertices). */
  result: number;
}

/** Greedy distance groups: `[survivor, merged[]]` in key order. */
function distanceGroups(draft: MeshDraft, keys: readonly string[], distance: number): [string, string[]][] {
  const consumed = new Set<string>();
  return keys.flatMap((key, index): [string, string[]][] => {
    if (consumed.has(key)) return [];
    const origin = draft.vertex(key);
    const near = keys.slice(index + 1).filter((other) => !consumed.has(other) && distanceBetween(origin, draft.vertex(other)) < distance);
    near.forEach((other) => consumed.add(other));
    return near.length ? [[key, near]] : [];
  });
}

/** Averages the UVs of group members inside every face holding at least two of them (the `in_center` UV step). */
function centerUvs(draft: MeshDraft, members: readonly string[]): void {
  [...draft.faces.entries()].forEach(([faceKey, face]) => {
    const matches = members.filter((key) => face.vertices.includes(key));
    if (matches.length < 2) return;
    const sum = matches.reduce<Vec2>((total, key) => [total[0] + (face.uv[key]?.[0] ?? 0), total[1] + (face.uv[key]?.[1] ?? 0)], [0, 0]);
    const mean: Vec2 = [sum[0] / matches.length, sum[1] / matches.length];
    draft.faces.set(faceKey, { ...face, uv: { ...face.uv, ...Object.fromEntries(matches.map((key) => [key, [mean[0], mean[1]] as Vec2])) } });
  });
}

/** Replaces `merged` with `survivor` in every face, the inner loop of `mergeVertices`. */
function collapseInto(draft: MeshDraft, survivor: string, merged: string): void {
  [...draft.faces.entries()].forEach(([faceKey, face]) => {
    const index = face.vertices.indexOf(merged);
    if (index === -1) return;
    const { [merged]: movedUv, ...uv } = face.uv;
    if (face.vertices.includes(survivor)) {
      const vertices = face.vertices.filter((key) => key !== merged);
      if (vertices.length < 2) {
        draft.faces.delete(faceKey);
        return;
      }
      draft.faces.set(faceKey, { ...face, vertices, uv });
      return;
    }
    const vertices = face.vertices.map((key) => (key === merged ? survivor : key));
    draft.faces.set(faceKey, { ...face, vertices, uv: { ...uv, [survivor]: movedUv ?? [0, 0] } });
  });
  draft.vertices.delete(merged);
}

/**
 * Port of `cleanupOverlappingMeshFaces`: drops faces with fewer than 2
 * vertices and faces whose vertex set is contained in another remaining face.
 */
export function cleanupOverlappingFaces(geometry: IMeshGeometry): IMeshGeometry {
  const draft = MeshDraft.from(geometry);
  [...draft.faces.keys()].forEach((key) => {
    const face = draft.faces.get(key);
    if (!face) return;
    if (face.vertices.length < 2) {
      draft.faces.delete(key);
      return;
    }
    const covered = [...draft.faces.entries()].some(([other, face2]: [string, MeshFaceData]) => other !== key && face.vertices.every((vertex) => face2.vertices.includes(vertex)));
    if (covered) draft.faces.delete(key);
  });
  return draft.toGeometry();
}

/**
 * Merges vertices closer than `distance`.
 *
 * @param keys - Candidate vertices (Blockbench's selection); all vertices when omitted.
 * @param inCenter - Move each survivor to its group's centroid and average UVs (the "in center" variant).
 * @throws Error for unknown keys or a non-positive distance.
 */
export function mergeByDistance(geometry: IMeshGeometry, distance: number, keys?: readonly string[], inCenter = false): IMergeResult {
  if (!(distance > 0) || !Number.isFinite(distance)) throw new Error("Merge distance must be a positive number.");
  if (keys) requireVertices(geometry, keys);
  const candidates = keys ? [...new Set(keys)] : Object.keys(geometry.vertices);
  if (candidates.length < 2) return { geometry, found: 0, result: 0 };
  const draft = MeshDraft.from(geometry);
  const groups = distanceGroups(draft, candidates, distance);
  groups.forEach(([survivor, merged]) => {
    if (inCenter) {
      const members = [survivor, ...merged];
      draft.vertices.set(survivor, centroid(members.map((key) => draft.vertex(key))));
      centerUvs(draft, members);
    }
    merged.forEach((key) => collapseInto(draft, survivor, key));
  });
  const found = groups.reduce((total, [, merged]) => total + merged.length + 1, 0);
  return { geometry: cleanupOverlappingFaces(draft.toGeometry()), found, result: groups.length };
}
