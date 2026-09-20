import { describe, expect, test } from "bun:test";
import { buildPolyhedronGeometry, planarFaceUv, POLYHEDRON_SHAPES, type Point3, type PolyhedronShape } from "./mesh-primitives";

/** Expected [vertices, faces] per shape at detail 0 and 1 (three.js tables, merged by position). */
const COUNTS: Record<PolyhedronShape, Record<0 | 1, [number, number]>> = {
  icosphere: { 0: [12, 20], 1: [42, 80] },
  octahedron: { 0: [6, 8], 1: [18, 32] },
  dodecahedron: { 0: [20, 36], 1: [74, 144] },
};

const subtract = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Point3, b: Point3): Point3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Point3, b: Point3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const distance = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe("buildPolyhedronGeometry", () => {
  test.each(POLYHEDRON_SHAPES.flatMap((shape) => [0, 1].map((detail) => [shape, detail] as const)))(
    "%s detail %d has the expected merged topology (closed surface, Euler characteristic 2)",
    (shape, detail) => {
      const geometry = buildPolyhedronGeometry({ shape, diameter: 16, detail });
      const [vertexCount, faceCount] = COUNTS[shape][detail as 0 | 1];
      expect(geometry.vertices).toHaveLength(vertexCount);
      expect(geometry.faces).toHaveLength(faceCount);
      const edges = new Set(geometry.faces.flatMap((face) => face.map((index, corner) => {
        const next = face[(corner + 1) % 3];
        return index < next ? `${index}-${next}` : `${next}-${index}`;
      })));
      // Every edge is shared by exactly two triangles on a closed triangle mesh.
      expect(edges.size * 2).toBe(faceCount * 3);
      expect(vertexCount - edges.size + faceCount).toBe(2);
    },
  );

  test("splits each base triangle into (detail + 1)^2 triangles", () => {
    expect(buildPolyhedronGeometry({ shape: "icosphere", diameter: 8, detail: 6 }).faces).toHaveLength(20 * 49);
  });

  test.each(POLYHEDRON_SHAPES.map((shape) => [shape]))("%s vertices lie on the sphere of the given diameter", (shape) => {
    const geometry = buildPolyhedronGeometry({ shape, diameter: 10, detail: 2 });
    geometry.vertices.forEach((vertex) => expect(Math.hypot(...vertex)).toBeCloseTo(5, 9));
  });

  test.each(POLYHEDRON_SHAPES.map((shape) => [shape]))("%s triangles wind counter-clockwise from outside and are non-degenerate", (shape) => {
    const geometry = buildPolyhedronGeometry({ shape, diameter: 16, detail: 1 });
    geometry.faces.forEach((face) => {
      expect(new Set(face).size).toBe(3);
      const [a, b, c] = face.map((index) => geometry.vertices[index]);
      const normal = cross(subtract(b, a), subtract(c, a));
      const centroid: Point3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      expect(dot(normal, centroid)).toBeGreaterThan(0);
    });
  });

  test("UVs preserve each triangle's edge lengths and start at the origin", () => {
    const geometry = buildPolyhedronGeometry({ shape: "octahedron", diameter: 16, detail: 0 });
    geometry.faces.forEach((face, faceIndex) => {
      const uv = geometry.uvs[faceIndex];
      expect(uv).toHaveLength(3);
      expect(Math.min(...uv.map(([u]) => u))).toBeCloseTo(0, 9);
      expect(Math.min(...uv.map(([, v]) => v))).toBeCloseTo(0, 9);
      face.forEach((index, corner) => {
        const next = (corner + 1) % 3;
        const edge3d = Math.hypot(...subtract(geometry.vertices[index], geometry.vertices[face[next]]));
        expect(distance(uv[corner], uv[next])).toBeCloseTo(edge3d, 9);
      });
    });
  });

  test("is deterministic", () => {
    const options = { shape: "dodecahedron", diameter: 12, detail: 2 } as const;
    expect(buildPolyhedronGeometry(options)).toEqual(buildPolyhedronGeometry(options));
  });

  test.each([
    [{ detail: 7, diameter: 16 }],
    [{ detail: 1.5, diameter: 16 }],
    [{ detail: -1, diameter: 16 }],
    [{ detail: 1, diameter: 0 }],
    [{ detail: 1, diameter: Number.NaN }],
  ])("rejects invalid options %o", (options) => {
    expect(() => buildPolyhedronGeometry({ shape: "icosphere", ...options })).toThrow();
  });
});

describe("planarFaceUv", () => {
  test("lays an axis-aligned quad flat with v growing downward", () => {
    const uv = planarFaceUv([[0, 0, 0], [4, 0, 0], [4, 2, 0], [0, 2, 0]]);
    expect(uv.map(([u, v]) => [u + 0, v + 0])).toEqual([[0, 2], [4, 2], [4, 0], [0, 0]]);
  });
});
