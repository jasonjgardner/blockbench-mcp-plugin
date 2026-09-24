/**
 * Mesh UV mapping.
 *
 * {@link autoUvFace} is a line-by-line port of the mesh branch of Blockbench's
 * `UVEditor.setAutoSize` (js/uv/uv.js), the "Auto UV" action Blockbench also
 * runs on every face right after `add_mesh` creates a primitive. It flattens
 * each face onto its own plane at 1 UV unit per model unit, turns it so its
 * dominant edge direction is axis-aligned, snaps it to the pixel grid near its
 * previous UV position, and pushes it back inside the UV space when it spills
 * over. Faces are mapped independently (islands may overlap).
 *
 * {@link projectUv} is a headless addition: an orthographic planar projection
 * along one model axis, the fixed-camera analogue of Blockbench's
 * `uv_project_from_view` (which depends on the live viewport camera).
 *
 * @module
 */

import { type IMeshGeometry, type MeshFaceData, roundTo, type UvSize, type Vec2, type Vec3 } from "./types";
import { faceNormal, lookupIn, sortedVertices, type VertexLookup } from "./face";
import { applyEulerXYZ, directionToRotation, projectOntoPlane } from "./vector";

const DEG = Math.PI / 180;

/** Dominant edge angle of a flattened face, snapped like Blockbench (2° buckets, most common wins, ties to the smaller bucket). */
function dominantAngle(flat: Readonly<Record<string, Vec2>>, sorted: readonly string[]): number {
  const buckets = sorted.reduce<{ counts: Map<number, number>; precise: Map<number, number> }>((state, key, index) => {
    const next = sorted[index + 1] ?? sorted[0] ?? key;
    const from = flat[key] ?? [0, 0];
    const to = flat[next] ?? [0, 0];
    const degrees = ((Math.atan2(to[0] - from[0], to[1] - from[1]) / DEG) + 360) % 90;
    const bucket = Math.round(degrees / 2) * 2;
    const counts = new Map(state.counts).set(bucket, (state.counts.get(bucket) ?? 0) + 1);
    const precise = state.precise.has(bucket) ? state.precise : new Map(state.precise).set(bucket, degrees);
    return { counts, precise };
  }, { counts: new Map(), precise: new Map() });
  const [best] = [...buckets.counts.keys()].toSorted((a, b) => ((buckets.counts.get(b) ?? 0) - (buckets.counts.get(a) ?? 0)) || (a < b ? -1 : 1));
  return best === undefined ? 0 : (buckets.precise.get(best) ?? 0) * DEG;
}

/**
 * Port of the mesh branch of `UVEditor.setAutoSize` for one face.
 *
 * @param lookup - Vertex positions (local).
 * @param face - The face; its current UVs decide where the new island lands.
 * @param uvSize - UV space `[width, height]` (the project resolution, or the
 *   face texture's `uv_width`/`uv_height` in per-texture-UV formats such as free).
 * @returns New per-vertex UVs keyed like `face.vertices`.
 */
export function autoUvFace(lookup: VertexLookup, face: MeshFaceData, uvSize: UvSize): Record<string, Vec2> {
  const keys = face.vertices;
  const [firstKey] = keys;
  if (firstKey === undefined) return {};
  const normal = faceNormal(lookup, face, true);
  const planePoint = lookup(firstKey);
  const [yaw, pitch] = directionToRotation(normal);
  const flat: Record<string, Vec2> = Object.fromEntries(keys.map((key) => {
    const onPlane = applyEulerXYZ(projectOntoPlane(lookup(key), normal, planePoint), (pitch - 90) * DEG, (yaw + 180) * DEG, 0);
    return [key, [roundTo(onPlane[0], 4), roundTo(onPlane[2], 4)] as Vec2];
  }));
  const angle = dominantAngle(flat, sortedVertices(lookup, face));
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  const turned: Record<string, Vec2> = Object.fromEntries(Object.entries(flat).map(([key, [x, y]]) => [key, [x * c - y * s, x * s + y * c] as Vec2]));

  const at = (key: string): Vec2 => turned[key] ?? [0, 0];
  const pminX = Math.min(...keys.map((key) => at(key)[0]));
  const pminY = Math.min(...keys.map((key) => at(key)[1]));
  const oldSum = keys.reduce<Vec2>((sum, key) => [sum[0] + (face.uv[key]?.[0] ?? 0), sum[1] + (face.uv[key]?.[1] ?? 0)], [0, 0]);
  const newSum = keys.reduce<Vec2>((sum, key) => [sum[0] + at(key)[0], sum[1] + at(key)[1]], [0, 0]);
  const center: Vec2 = [Math.round((oldSum[0] - newSum[0]) / keys.length), Math.round((oldSum[1] - newSum[1]) / keys.length)];
  const snapX = ((pminX + 1000.5) % 1) - 0.5;
  const snapY = ((pminY + 1000.5) % 1) - 0.5;
  const placed: Record<string, Vec2> = Object.fromEntries(Object.entries(turned).map(([key, [x, y]]) => [key, [x - snapX + center[0], y - snapY + center[1]] as Vec2]));

  // Blockbench starts max at 0, not -Infinity; kept for identical overflow behavior.
  const values = Object.values(placed);
  const minX = Math.min(Infinity, ...values.map((uv) => uv[0]));
  const minY = Math.min(Infinity, ...values.map((uv) => uv[1]));
  const maxX = Math.max(0, ...values.map((uv) => uv[0]));
  const maxY = Math.max(0, ...values.map((uv) => uv[1]));
  const overflow = (min: number, max: number, size: number): number => {
    if (min < 0) return -min;
    return max > size ? Math.round(size - max) : 0;
  };
  const offset: Vec2 = [overflow(minX, maxX, uvSize[0]), overflow(minY, maxY, uvSize[1])];
  return Object.fromEntries(keys.map((key) => {
    const uv = placed[key] ?? [0, 0];
    return [key, [uv[0] + offset[0], uv[1] + offset[1]] as Vec2];
  }));
}

/**
 * Runs {@link autoUvFace} on several faces in order, like `setAutoSize(null, true, face_keys)`.
 *
 * @param uvSizeOf - UV space for a face (lets textured faces use their texture's uv size).
 */
export function autoUvFaces(geometry: IMeshGeometry, faceKeys: readonly string[], uvSizeOf: (face: MeshFaceData) => UvSize): IMeshGeometry {
  const lookup = lookupIn(geometry);
  const targets = new Set(faceKeys);
  const faces = Object.fromEntries(Object.entries(geometry.faces).map(([key, face]) => [key, targets.has(key) ? { ...face, uv: autoUvFace(lookup, face, uvSizeOf(face)) } : face]));
  return { ...geometry, faces };
}

/** Axis a planar projection looks along. */
export type ProjectionAxis = "x" | "y" | "z";

/**
 * Screen coordinates of a local point for an orthographic camera looking along
 * `axis` with +Y up (Blockbench's East, Top and South views): `x` looks from +X
 * (u = -z, v = -y), `y` from above (u = x, v = z), `z` from +Z (u = x, v = -y).
 */
const PROJECTORS: Readonly<Record<ProjectionAxis, (p: Vec3) => Vec2>> = {
  x: (p) => [-p[2], -p[1]],
  y: (p) => [p[0], p[2]],
  z: (p) => [p[0], -p[1]],
};

/**
 * Planar projection of the listed faces along a model axis (headless addition,
 * see the module notes). All listed faces share one projection, so connected
 * faces stay connected; the result is scaled by `factor` and shifted so its
 * minimum sits at `[0, 0]`.
 */
export function projectUv(geometry: IMeshGeometry, faceKeys: readonly string[], axis: ProjectionAxis, factor = 1): IMeshGeometry {
  const lookup = lookupIn(geometry);
  const project = PROJECTORS[axis];
  const targets = faceKeys.filter((key) => geometry.faces[key] !== undefined);
  const points = targets.flatMap((key) => (geometry.faces[key]?.vertices ?? []).map((vertex) => project(lookup(vertex))));
  const minU = Math.min(...points.map((p) => p[0]));
  const minV = Math.min(...points.map((p) => p[1]));
  const selected = new Set(targets);
  const faces = Object.fromEntries(Object.entries(geometry.faces).map(([key, face]) => {
    if (!selected.has(key)) return [key, face];
    const uv = Object.fromEntries(face.vertices.map((vertex) => {
      const [u, v] = project(lookup(vertex));
      return [vertex, [roundTo((u - minU) * factor, 4), roundTo((v - minV) * factor, 4)] as Vec2];
    }));
    return [key, { ...face, uv }];
  }));
  return { ...geometry, faces };
}
