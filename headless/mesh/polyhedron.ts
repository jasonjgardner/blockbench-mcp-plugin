/**
 * Port of three.js r129 `PolyhedronGeometry` and its `Icosahedron`,
 * `Octahedron` and `Dodecahedron` subclasses, which Blockbench's Add Mesh
 * dialog (js/modeling/mesh/add_mesh.ts, the `HEDRONS` branch) turns into mesh
 * faces.
 *
 * three builds a non-indexed `Float32BufferAttribute`, so every coordinate is
 * rounded to float32 before Blockbench deduplicates vertices by exact equality.
 * {@link polyhedronTriangles} applies `Math.fround` for the same reason, which
 * keeps vertex counts identical to what Blockbench produces.
 *
 * @module
 */

import type { Vec3 } from "./types";
import { lerp3 } from "./vector";

/** Polyhedron shapes offered by the Add Mesh dialog. */
export const HEDRON_SHAPES = ["icosphere", "octahedron", "dodecahedron"] as const;

/** One of {@link HEDRON_SHAPES}. */
export type HedronShape = (typeof HEDRON_SHAPES)[number];

const T = (1 + Math.sqrt(5)) / 2;
const R = 1 / T;

/** Base vertices (flat xyz triples) and triangle indices, copied from three's geometry classes. */
const BASES: Readonly<Record<HedronShape, { vertices: readonly number[]; indices: readonly number[] }>> = {
  icosphere: {
    vertices: [-1, T, 0, 1, T, 0, -1, -T, 0, 1, -T, 0, 0, -1, T, 0, 1, T, 0, -1, -T, 0, 1, -T, T, 0, -1, T, 0, 1, -T, 0, -1, -T, 0, 1],
    indices: [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1],
  },
  octahedron: {
    vertices: [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1],
    indices: [0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 3, 1, 3, 4, 1, 4, 2],
  },
  dodecahedron: {
    vertices: [
      -1, -1, -1, -1, -1, 1, -1, 1, -1, -1, 1, 1, 1, -1, -1, 1, -1, 1, 1, 1, -1, 1, 1, 1,
      0, -R, -T, 0, -R, T, 0, R, -T, 0, R, T,
      -R, -T, 0, -R, T, 0, R, -T, 0, R, T, 0,
      -T, 0, -R, T, 0, -R, -T, 0, R, T, 0, R,
    ],
    indices: [
      3, 11, 7, 3, 7, 15, 3, 15, 13, 7, 19, 17, 7, 17, 6, 7, 6, 15, 17, 4, 8, 17, 8, 10, 17, 10, 6, 8, 0, 16, 8, 16, 2, 8, 2, 10,
      0, 12, 1, 0, 1, 18, 0, 18, 16, 6, 10, 2, 6, 2, 13, 6, 13, 15, 2, 16, 18, 2, 18, 3, 2, 3, 13, 18, 1, 9, 18, 9, 11, 18, 11, 3,
      4, 14, 12, 4, 12, 0, 4, 0, 8, 11, 9, 5, 11, 5, 19, 11, 19, 7, 19, 5, 14, 19, 14, 4, 19, 4, 17, 1, 12, 14, 1, 14, 5, 1, 5, 9,
    ],
  },
};

/**
 * three's `vertex.normalize().multiplyScalar(radius)`, operation for operation:
 * `normalize` multiplies by the reciprocal length (`divideScalar`), which can
 * differ in the last bit from dividing, and those bits decide vertex sharing.
 */
function applyRadius(point: Vec3, radius: number): Vec3 {
  const size = Math.sqrt(point[0] * point[0] + point[1] * point[1] + point[2] * point[2]) || 1;
  const inverse = 1 / size;
  return [point[0] * inverse * radius, point[1] * inverse * radius, point[2] * inverse * radius];
}

const baseVertex = (vertices: readonly number[], index: number): Vec3 => [vertices[index * 3] ?? 0, vertices[index * 3 + 1] ?? 0, vertices[index * 3 + 2] ?? 0];

/** Port of `PolyhedronGeometry.subdivideFace`: emits the corner points of `(detail + 1)²` triangles. */
function subdivideFace(a: Vec3, b: Vec3, c: Vec3, detail: number): Vec3[] {
  const cols = detail + 1;
  const grid: Vec3[][] = Array.from({ length: cols + 1 }, (_, i) => {
    const aj = lerp3(a, c, i / cols);
    const bj = lerp3(b, c, i / cols);
    const rows = cols - i;
    return Array.from({ length: rows + 1 }, (_, j) => (j === 0 && i === cols ? aj : lerp3(aj, bj, j / rows)));
  });
  const at = (i: number, j: number): Vec3 => grid[i]?.[j] ?? [0, 0, 0];
  return Array.from({ length: cols }, (_, i) => i).flatMap((i) =>
    Array.from({ length: 2 * (cols - i) - 1 }, (_, j) => j).flatMap((j) => {
      const k = Math.floor(j / 2);
      return j % 2 === 0 ? [at(i, k + 1), at(i + 1, k), at(i, k)] : [at(i, k + 1), at(i + 1, k + 1), at(i + 1, k)];
    }),
  );
}

/**
 * The non-indexed position buffer three builds for a polyhedron: consecutive
 * triples are triangles, every point pushed to `radius` and rounded to float32.
 *
 * @param radius - three's radius. Blockbench passes its "diameter" field here unchanged.
 * @param detail - Subdivision level (0 to 6 in the dialog).
 */
export function polyhedronTriangles(shape: HedronShape, radius: number, detail: number): Vec3[] {
  const { vertices, indices } = BASES[shape];
  const corners = Array.from({ length: indices.length / 3 }, (_, face) => face * 3).flatMap((i) =>
    subdivideFace(baseVertex(vertices, indices[i] ?? 0), baseVertex(vertices, indices[i + 1] ?? 0), baseVertex(vertices, indices[i + 2] ?? 0), detail),
  );
  return corners.map((point) => {
    const [x, y, z] = applyRadius(point, radius);
    return [Math.fround(x), Math.fround(y), Math.fround(z)];
  });
}
