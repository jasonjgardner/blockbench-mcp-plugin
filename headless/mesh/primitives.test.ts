import { describe, expect, test } from "bun:test";
import { faceNormal, lookupIn } from "./face";
import { polyhedronTriangles } from "./polyhedron";
import { buildPrimitive, PRIMITIVE_DEFAULTS, PRIMITIVE_SHAPES, type PrimitiveShape } from "./primitives";
import { countsOf } from "./types";
import { centroid, dot, sub } from "./vector";

const build = (shape: PrimitiveShape, overrides: Partial<typeof PRIMITIVE_DEFAULTS> = {}) => buildPrimitive({ shape, ...PRIMITIVE_DEFAULTS, ...overrides }, [16, 16]);

describe("Add Mesh dialog port (js/modeling/mesh/add_mesh.ts)", () => {
  // Counts derived from Blockbench's runEdit loops with the dialog defaults
  // (diameter 16, height 8, sides 12, minor_sides 8, detail 1); polyhedron
  // counts were cross-checked against three.js r129 geometry.
  const expected: Record<PrimitiveShape, [number, number]> = {
    cuboid: [8, 6],
    beveled_cuboid: [24, 26],
    pyramid: [5, 5],
    plane: [4, 1],
    circle: [13, 12],
    cylinder: [26, 36],
    tube: [48, 48],
    cone: [14, 24],
    sphere: [62, 72],
    icosphere: [42, 80],
    octahedron: [18, 32],
    dodecahedron: [74, 144],
    torus: [96, 96],
  };

  test.each(PRIMITIVE_SHAPES.map((shape) => [shape]))("%s has Blockbench's vertex and face counts", (shape) => {
    const { geometry } = build(shape);
    const counts = countsOf(geometry);
    expect([counts.vertices, counts.faces]).toEqual(expected[shape]);
  });

  test("names follow Blockbench (cuboid is renamed to mesh)", () => {
    expect(build("cuboid").name).toBe("mesh");
    expect(build("torus").name).toBe("torus");
  });

  test.each([["cuboid"], ["beveled_cuboid"], ["pyramid"], ["cylinder"], ["sphere"], ["icosphere"], ["dodecahedron"]] as [PrimitiveShape][])(
    "%s faces wind outwards",
    (shape) => {
      const { geometry } = build(shape);
      const lookup = lookupIn(geometry);
      const center = centroid(Object.values(geometry.vertices));
      const inward = Object.values(geometry.faces).filter((face) => {
        const faceCenter = centroid(face.vertices.map(lookup));
        return dot(faceNormal(lookup, face), sub(faceCenter, center)) < -1e-9;
      });
      expect(inward.length).toBe(0);
    },
  );

  test("align_edges widens round shapes by 1/cos(pi/sides)", () => {
    const aligned = Math.max(...Object.values(build("circle").geometry.vertices).map((v) => Math.hypot(v[0], v[2])));
    const plain = Math.max(...Object.values(build("circle", { align_edges: false }).geometry.vertices).map((v) => Math.hypot(v[0], v[2])));
    expect(plain).toBeCloseTo(8, 9);
    expect(aligned).toBeCloseTo(8 / Math.cos(Math.PI / 12), 9);
  });

  test("polyhedra use the diameter field as three.js radius, like Blockbench", () => {
    const radius = Math.hypot(...(polyhedronTriangles("icosphere", 16, 0)[0] ?? [0, 0, 0]));
    expect(radius).toBeCloseTo(16, 4);
  });

  test("every face gets Auto UV inside the UV space", () => {
    const { geometry } = build("sphere");
    const uvs = Object.values(geometry.faces).flatMap((face) => Object.values(face.uv));
    expect(uvs.every(([u, v]) => u >= -1e-9 && v >= -1e-9 && u <= 16 + 1e-9 && v <= 16 + 1e-9)).toBe(true);
    expect(Object.values(geometry.faces).every((face) => face.vertices.every((key) => face.uv[key] !== undefined))).toBe(true);
  });

  test("sphere rounds odd side counts to an even ring count", () => {
    expect(countsOf(build("sphere", { sides: 7 }).geometry)).toEqual({ vertices: 7 * 3 + 2, faces: 7 * 4 });
  });
});
