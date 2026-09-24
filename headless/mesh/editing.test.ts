import { describe, expect, test } from "bun:test";
import { autoUvFace } from "./auto-uv";
import { deleteFaces, deleteVertices, flipFaces, moveVertices, transformVertices } from "./editing";
import { extrudeFaces } from "./extrude";
import { faceNormal, lookupIn, sortedVertices } from "./face";
import { loopCut } from "./loop-cut";
import { mergeByDistance } from "./merge";
import { buildPrimitive, PRIMITIVE_DEFAULTS } from "./primitives";
import { subdivideFaces } from "./subdivide";
import { countsOf, type IMeshGeometry } from "./types";

const cube = (): IMeshGeometry => buildPrimitive({ shape: "cuboid", ...PRIMITIVE_DEFAULTS, height: 16 }, [16, 16]).geometry;
const plane = (): IMeshGeometry => buildPrimitive({ shape: "plane", ...PRIMITIVE_DEFAULTS }, [16, 16]).geometry;
const faceWithNormal = (geometry: IMeshGeometry, axis: 0 | 1 | 2, sign: 1 | -1): string => {
  const lookup = lookupIn(geometry);
  const found = Object.entries(geometry.faces).find(([, face]) => faceNormal(lookup, face)[axis] * sign > 0.99);
  if (!found) throw new Error("no such face");
  return found[0];
};

describe("vertex edits", () => {
  test("move and transform never mutate the input", () => {
    const base = cube();
    const snapshot = JSON.stringify(base);
    const moved = moveVertices(base, [1, 2, 3]);
    const turned = transformVertices(base, { rotate: [0, 90, 0], pivot: [0, 0, 0] });
    expect(JSON.stringify(base)).toBe(snapshot);
    const key = Object.keys(base.vertices)[0] as string;
    const [x, y, z] = base.vertices[key] ?? [0, 0, 0];
    expect(moved.vertices[key]).toEqual([x + 1, y + 2, z + 3]);
    const rotated = turned.vertices[key] ?? [0, 0, 0];
    expect(rotated[0]).toBeCloseTo(z, 9);
    expect(rotated[2]).toBeCloseTo(-x, 9);
  });

  test("deleting a cube corner turns three quads into triangles and keeps them outward", () => {
    const base = cube();
    const corner = Object.keys(base.vertices)[0] as string;
    const result = deleteVertices(base, [corner]);
    expect(countsOf(result)).toEqual({ vertices: 7, faces: 6 });
    expect(Object.values(result.faces).filter((face) => face.vertices.length === 3).length).toBe(3);
  });

  test("deleting a triangle vertex drops faces that fall below 3 vertices", () => {
    const tri: IMeshGeometry = { vertices: { a: [0, 0, 0], b: [1, 0, 0], c: [0, 0, 1], d: [5, 5, 5] }, faces: { f: { vertices: ["a", "b", "c"], uv: {} } } };
    expect(countsOf(deleteVertices(tri, ["a"]))).toEqual({ vertices: 3, faces: 0 });
  });
});

describe("face edits", () => {
  test("delete_faces removes orphaned vertices only", () => {
    const base = cube();
    const top = faceWithNormal(base, 1, 1);
    expect(countsOf(deleteFaces(base, [top]))).toEqual({ vertices: 8, faces: 5 });
    const plate = plane();
    expect(countsOf(deleteFaces(plate, Object.keys(plate.faces)))).toEqual({ vertices: 0, faces: 0 });
  });

  test("flip reverses the normal and keeps each vertex's UV", () => {
    const base = plane();
    const key = Object.keys(base.faces)[0] as string;
    const flipped = flipFaces(base, [key]);
    const before = faceNormal(lookupIn(base), base.faces[key] as never);
    const after = faceNormal(lookupIn(flipped), flipped.faces[key] as never);
    expect(after[1]).toBeCloseTo(-before[1], 9);
    expect(flipped.faces[key]?.uv).toEqual(base.faces[key]?.uv as never);
  });
});

describe("merge by distance (merge_split.ts)", () => {
  test("coincident vertices merge and overlapping faces are cleaned up", () => {
    const geometry: IMeshGeometry = {
      vertices: { a: [0, 0, 0], b: [1, 0, 0], c: [1, 0, 1], d: [0, 0, 1], e: [0.05, 0, 0] },
      faces: { q: { vertices: ["a", "b", "c", "d"], uv: {} }, t: { vertices: ["e", "b", "c"], uv: {} } },
    };
    const merged = mergeByDistance(geometry, 0.1);
    expect(merged.result).toBe(1);
    expect(merged.found).toBe(2);
    expect(Object.keys(merged.geometry.vertices)).not.toContain("e");
    // t became [a, b, c], a subset of q, so cleanupOverlappingMeshFaces removes it.
    expect(Object.keys(merged.geometry.faces)).toEqual(["q"]);
  });
});

describe("extrude (extrude_mesh_selection)", () => {
  test("extruding the top of a cube adds 4 vertices and 4 side quads, moving the cap outwards", () => {
    const base = cube();
    const top = faceWithNormal(base, 1, 1);
    const result = extrudeFaces(base, [top], { distance: 4 });
    expect(countsOf(result.geometry)).toEqual({ vertices: 12, faces: 10 });
    expect(result.sideFaces.length).toBe(4);
    const cap = result.geometry.faces[top];
    expect(cap?.vertices.every((key) => result.geometry.vertices[key]?.[1] === 20)).toBe(true);
    const lookup = lookupIn(result.geometry);
    const sideNormals = result.sideFaces.map((key) => faceNormal(lookup, result.geometry.faces[key] as never));
    expect(sideNormals.every((n) => Math.abs(n[1]) < 1e-9)).toBe(true);
  });

  test("extruding every face of a closed cube just moves it (originals deleted)", () => {
    const base = cube();
    const result = extrudeFaces(base, Object.keys(base.faces), { distance: 1 });
    expect(countsOf(result.geometry)).toEqual({ vertices: 8, faces: 6 });
  });
});

describe("loop cut (loop_cut.ts)", () => {
  test("one cut around a cube side ring adds 4 vertices and 4 faces", () => {
    const base = cube();
    const side = faceWithNormal(base, 0, 1);
    const result = loopCut(base, side);
    expect(countsOf(result.geometry)).toEqual({ vertices: 12, faces: 10 });
    expect(result.vertices.length).toBe(4);
  });

  test("two cuts add 8 vertices and 8 faces", () => {
    const base = cube();
    const result = loopCut(base, faceWithNormal(base, 0, 1), { cuts: 2 });
    expect(countsOf(result.geometry)).toEqual({ vertices: 16, faces: 14 });
  });
});

describe("subdivide", () => {
  test("a quad with 1 cut becomes 4 quads sharing 9 vertices", () => {
    const result = subdivideFaces(plane(), 1);
    expect(countsOf(result.geometry)).toEqual({ vertices: 9, faces: 4 });
  });

  test("neighboring faces share new edge vertices", () => {
    expect(countsOf(subdivideFaces(cube(), 1).geometry)).toEqual({ vertices: 26, faces: 24 });
  });
});

describe("Auto UV (UVEditor.setAutoSize)", () => {
  test("an axis-aligned 16x16 face maps to the full 0..16 square", () => {
    const base = cube();
    const lookup = lookupIn(base);
    const top = base.faces[faceWithNormal(base, 1, 1)];
    if (!top) throw new Error("missing");
    const uv = autoUvFace(lookup, top, [16, 16]);
    const us = Object.values(uv).map((p) => p[0]);
    const vs = Object.values(uv).map((p) => p[1]);
    expect([Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0, 16, 0, 16]);
    expect(sortedVertices(lookup, top).length).toBe(4);
  });
});
