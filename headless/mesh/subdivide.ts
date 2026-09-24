/**
 * Regular grid subdivision of triangles and quads.
 *
 * Blockbench itself has no subdivide action (its nearest tool is the loop cut,
 * ported in `./loop-cut`). This is a pure port of the desktop plugin's
 * `subdivideMeshFaces` (lib/mesh-editing.ts), so `bbmodel_edit` and the
 * desktop `subdivide_mesh` tool produce the same topology: every face becomes
 * `(cuts + 1)²` faces, bilinear on quads and barycentric on triangles, with
 * vertices on shared edges created once and reused by neighboring faces. Child
 * faces copy the source face's texture and interpolate its UVs.
 *
 * Only the listed faces are split, so an unlisted neighbor keeps its original
 * edge (a T-junction), exactly like the desktop tool.
 *
 * @module
 */

import { MAX_SUBDIVISION_CUTS } from "@/lib/constants";
import { makeFace, MeshDraft } from "./draft";
import { sortedVertices, type VertexLookup } from "./face";
import { requireFaces } from "./editing";
import type { IMeshGeometry, MeshFaceData, Vec2, Vec3 } from "./types";

/** Upper bound on cuts, shared with the desktop `subdivide_mesh` tool. */
export const MAX_SUBDIVIDE_CUTS = MAX_SUBDIVISION_CUTS;

const EPSILON = 1e-9;

type GridCoordinate = [number, number];

interface IGridPoint {
  key: string;
  uv: Vec2;
}

const weightsAt = (u: number, v: number, triangle: boolean): number[] => (triangle ? [1 - u - v, u, v] : [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v]);

const coordinates = (segments: number, triangle: boolean): GridCoordinate[] =>
  Array.from({ length: segments + 1 }, (_, i) => i).flatMap((i) => Array.from({ length: (triangle ? segments - i : segments) + 1 }, (_, j): GridCoordinate => [i, j]));

function cellPolygons(i: number, j: number, segments: number, triangle: boolean): GridCoordinate[][] {
  if (!triangle) return [[[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]]];
  const lower: GridCoordinate[] = [[i, j], [i + 1, j], [i, j + 1]];
  return i + j < segments - 1 ? [lower, [[i + 1, j], [i + 1, j + 1], [i, j + 1]]] : [lower];
}

const cells = (segments: number, triangle: boolean): GridCoordinate[][] =>
  Array.from({ length: segments }, (_, i) => i).flatMap((i) => Array.from({ length: triangle ? segments - i : segments }, (_, j) => j).flatMap((j) => cellPolygons(i, j, segments, triangle)));

/** Splits one face; `shared` maps edge-point cache keys to vertices already created by neighbors. */
function subdivideFace(draft: MeshDraft, faceKey: string, segments: number, shared: Map<string, string>): string[] {
  const source = draft.faces.get(faceKey) as MeshFaceData;
  const lookup: VertexLookup = (key) => draft.vertex(key);
  const corners = sortedVertices(lookup, source);
  const triangle = corners.length === 3;
  const pointAt = ([i, j]: GridCoordinate): IGridPoint => {
    const weights = weightsAt(i / segments, j / segments, triangle);
    const active = corners.map((corner, index) => ({ corner, weight: weights[index] ?? 0 })).filter((entry) => entry.weight > EPSILON);
    const weighted = (read: (corner: string) => number): number => corners.reduce((sum, corner, index) => sum + read(corner) * (weights[index] ?? 0), 0);
    const uv: Vec2 = [weighted((c) => source.uv[c]?.[0] ?? 0), weighted((c) => source.uv[c]?.[1] ?? 0)];
    const [only] = active;
    if (active.length === 1 && only) return { key: only.corner, uv };
    const cacheKey = active.length > 2
      ? `${faceKey}:${i}:${j}`
      : JSON.stringify(active.map(({ corner, weight }): [string, number] => [corner, Math.round(weight * segments)]).toSorted((a, b) => a[0].localeCompare(b[0])));
    const existing = shared.get(cacheKey);
    if (existing) return { key: existing, uv };
    const position: Vec3 = [weighted((c) => lookup(c)[0]), weighted((c) => lookup(c)[1]), weighted((c) => lookup(c)[2])];
    const [created] = draft.addVertices(position);
    shared.set(cacheKey, created as string);
    return { key: created as string, uv };
  };
  const points = new Map(coordinates(segments, triangle).map((coordinate): [string, IGridPoint] => [coordinate.join(":"), pointAt(coordinate)]));
  const { vertices: _v, uv: _u, ...props } = source;
  const children = cells(segments, triangle).map((cell) => {
    const values = cell.map((coordinate) => points.get(coordinate.join(":")) as IGridPoint);
    return makeFace(values.map((value) => value.key), Object.fromEntries(values.map((value) => [value.key, value.uv])), props);
  });
  draft.faces.delete(faceKey);
  return draft.addFaces(...children);
}

/**
 * Subdivides faces into a regular grid with `cuts + 1` segments per edge.
 *
 * @param faceKeys - Faces to split; all faces when omitted.
 * @throws Error for unknown faces, faces without 3 or 4 vertices, or cuts outside 1..{@link MAX_SUBDIVIDE_CUTS}.
 */
export function subdivideFaces(geometry: IMeshGeometry, cuts: number, faceKeys?: readonly string[]): { geometry: IMeshGeometry; faces: string[] } {
  if (!Number.isInteger(cuts) || cuts < 1 || cuts > MAX_SUBDIVIDE_CUTS) throw new Error(`cuts must be an integer from 1 to ${MAX_SUBDIVIDE_CUTS}.`);
  const keys = faceKeys ? [...new Set(faceKeys)] : Object.keys(geometry.faces);
  requireFaces(geometry, keys);
  const bad = keys.find((key) => {
    const count = geometry.faces[key]?.vertices.length ?? 0;
    return count < 3 || count > 4;
  });
  if (bad) throw new Error(`Face ${bad} is not a triangle or quad; only those can be subdivided.`);
  const draft = MeshDraft.from(geometry);
  const shared = new Map<string, string>();
  const faces = keys.flatMap((key) => subdivideFace(draft, key, cuts + 1, shared));
  return { geometry: draft.toGeometry(), faces };
}
