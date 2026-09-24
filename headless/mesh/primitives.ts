/**
 * Port of Blockbench's Add Mesh dialog (`add_primitive` in
 * js/modeling/mesh/add_mesh.ts, `runEdit`).
 *
 * Each builder adds vertices and faces in the same order, with the same
 * winding, as Blockbench, so vertex and face counts, positions and normals
 * match a mesh made in the app. Like the dialog, {@link buildPrimitive} then
 * runs Auto UV (`UVEditor.setAutoSize(null, true, all faces)`) over every face.
 *
 * @module
 */

import { autoUvFaces } from "./auto-uv";
import { makeFace, MeshDraft } from "./draft";
import { HEDRON_SHAPES, type HedronShape, polyhedronTriangles } from "./polyhedron";
import { EMPTY_GEOMETRY, type IMeshGeometry, type UvSize, type Vec2, type Vec3 } from "./types";

/** Shapes in the dialog's order (`SHAPE_OPTIONS`). */
export const PRIMITIVE_SHAPES = ["cuboid", "beveled_cuboid", "pyramid", "plane", "circle", "cylinder", "tube", "cone", "sphere", "icosphere", "octahedron", "dodecahedron", "torus"] as const;

/** One primitive shape. */
export type PrimitiveShape = (typeof PRIMITIVE_SHAPES)[number];

/** Dialog fields, all in model units except counts. */
export interface IPrimitiveOptions {
  shape: PrimitiveShape;
  /** Base diameter (16). For polyhedra Blockbench passes it to three as the radius. */
  diameter: number;
  /** Polyhedron subdivision level, 0 to 6 (1). */
  detail: number;
  /** Scales round shapes by 1/cos(π/sides) and rotates them half a side so flat edges face the axes (true). */
  align_edges: boolean;
  /** Height of cylinder, cone, cuboid, beveled cuboid, pyramid and tube (8). */
  height: number;
  /** Segments around round shapes, 3 to 48 (12). */
  sides: number;
  /** Tube wall thickness ×2 or torus tube diameter (4). */
  minor_diameter: number;
  /** Segments around the torus tube, 2 to 32 (8). */
  minor_sides: number;
  /** Bevel size of the beveled cuboid (2). */
  edge_size: number;
}

/** Dialog defaults from the `add_primitive` form. */
export const PRIMITIVE_DEFAULTS: Omit<IPrimitiveOptions, "shape"> = {
  diameter: 16,
  detail: 1,
  align_edges: true,
  height: 8,
  sides: 12,
  minor_diameter: 4,
  minor_sides: 8,
  edge_size: 2,
};

/** A built primitive: Blockbench's default element name for the shape, plus geometry. */
export interface IPrimitiveResult {
  name: string;
  geometry: IMeshGeometry;
}

/** Shared ring math: `diameter_factor` and `off_ang` from `runEdit`. */
function ringOf(o: IPrimitiveOptions): (i: number, radius: number) => [number, number] {
  const factor = o.align_edges ? 1 / Math.cos(Math.PI / o.sides) : 1;
  const offset = o.align_edges ? 0.5 : 0;
  return (i, radius) => {
    const angle = ((i + offset) / o.sides) * Math.PI * 2;
    return [Math.sin(angle) * radius * factor, Math.cos(angle) * radius * factor];
  };
}

const range = (count: number): number[] => Array.from({ length: Math.max(0, count) }, (_, i) => i);
const keyAt = (keys: readonly string[], index: number): string | undefined => keys[index];
const must = (key: string | undefined): string => {
  if (key === undefined) throw new Error("Primitive builder referenced a missing vertex.");
  return key;
};

function circle(d: MeshDraft, o: IPrimitiveOptions): void {
  const ring = ringOf(o);
  const [m] = d.addVertices([0, 0, 0]);
  const keys = [must(m), ...range(o.sides).flatMap((i) => {
    const [x, z] = ring(i, o.diameter / 2);
    return d.addVertices([x, 0, z]);
  })];
  range(o.sides).forEach((i) => {
    const a0 = keyAt(keys, i + 2);
    const b0 = keyAt(keys, i + 3);
    const [a, b] = a0 === undefined ? [keys[1], keys[2]] : [a0, b0 ?? keys[1]];
    d.addFaces(makeFace([must(a), must(b), must(m)]));
  });
}

function cone(d: MeshDraft, o: IPrimitiveOptions): void {
  const ring = ringOf(o);
  const [m0, m1] = d.addVertices([0, 0, 0], [0, o.height, 0]);
  const keys = [must(m0), must(m1), ...range(o.sides).flatMap((i) => {
    const [x, z] = ring(i, o.diameter / 2);
    return d.addVertices([x, 0, z]);
  })];
  range(o.sides).forEach((i) => {
    const a = must(keyAt(keys, i + 2));
    const b = keyAt(keys, i + 3) ?? must(keys[2]);
    d.addFaces(makeFace([b, a, must(m0)]), makeFace([a, b, must(m1)]));
  });
}

function cylinder(d: MeshDraft, o: IPrimitiveOptions): void {
  const ring = ringOf(o);
  const [m0, m1] = d.addVertices([0, 0, 0], [0, o.height, 0]);
  const keys = [must(m0), must(m1), ...range(o.sides).flatMap((i) => {
    const [x, z] = ring(i, o.diameter / 2);
    return d.addVertices([x, 0, z], [x, o.height, z]);
  })];
  range(o.sides).forEach((i) => {
    const a = must(keyAt(keys, 2 * i + 2));
    const b = must(keyAt(keys, 2 * i + 3));
    const c = keyAt(keys, 2 * i + 4) ?? must(keys[2]);
    const dd = keyAt(keys, 2 * i + 4) === undefined ? must(keys[3]) : must(keyAt(keys, 2 * i + 5));
    d.addFaces(makeFace([c, a, must(m0)]), makeFace([a, c, dd, b]), makeFace([b, dd, must(m1)]));
  });
}

function tube(d: MeshDraft, o: IPrimitiveOptions): void {
  const factor = o.align_edges ? 1 / Math.cos(Math.PI / o.sides) : 1;
  const offset = o.align_edges ? 0.5 : 0;
  const outer = (o.diameter / 2) * factor;
  // Blockbench applies diameter_factor twice to the inner radius; kept for identical output.
  const inner = (outer - o.minor_diameter / 2) * factor;
  const keys = range(o.sides).flatMap((i) => {
    const angle = ((i + offset) / o.sides) * Math.PI * 2;
    const x = Math.sin(angle);
    const z = Math.cos(angle);
    return d.addVertices([x * outer, 0, z * outer], [x * outer, o.height, z * outer], [x * inner, 0, z * inner], [x * inner, o.height, z * inner]);
  });
  range(o.sides).forEach((i) => {
    const wrap = keyAt(keys, 4 * i + 4) === undefined;
    const [a1, b1, c1, d1] = [0, 1, 2, 3].map((n) => must(keyAt(keys, 4 * i + n)));
    const [a2, b2, c2, d2] = [0, 1, 2, 3].map((n) => must(keyAt(keys, wrap ? n : 4 * i + 4 + n)));
    d.addFaces(
      makeFace([a1, a2, b2, b1] as string[]),
      makeFace([d1, d2, c2, c1] as string[]),
      makeFace([c1, c2, a2, a1] as string[]),
      makeFace([b1, b2, d2, d1] as string[]),
    );
  });
}

function torus(d: MeshDraft, o: IPrimitiveOptions): void {
  const factor = o.align_edges ? 1 / Math.cos(Math.PI / o.sides) : 1;
  const offset = o.align_edges ? 0.5 : 0;
  const rings = range(o.sides).map((i) => {
    const cx = Math.sin(((i + offset) / o.sides) * Math.PI * 2);
    const cz = Math.cos(((i + offset) / o.sides) * Math.PI * 2);
    return range(o.minor_sides).flatMap((j) => {
      const slice = Math.sin((j / o.minor_sides) * Math.PI * 2) * (o.minor_diameter / 2) * factor;
      const y = Math.cos((j / o.minor_sides) * Math.PI * 2) * (o.minor_diameter / 2) * factor;
      return d.addVertices([cx * ((o.diameter / 2) * factor + slice), y, cz * ((o.diameter / 2) * factor + slice)]);
    });
  });
  range(o.sides).forEach((i) => {
    const here = rings[i] ?? [];
    const next = rings[i + 1] ?? rings[0] ?? [];
    range(o.minor_sides).forEach((j) => {
      d.addFaces(makeFace([must(here[j + 1] ?? here[0]), must(next[j + 1] ?? next[0]), must(here[j]), must(next[j])]));
    });
  });
}

function sphere(d: MeshDraft, o: IPrimitiveOptions): void {
  const factor = o.align_edges ? 1 / Math.cos(Math.PI / o.sides) : 1;
  const offset = o.align_edges ? 0.5 : 0;
  const sides = Math.round(o.sides / 2) * 2;
  const [bottom] = d.addVertices([0, -o.diameter / 2, 0]);
  const [top] = d.addVertices([0, o.diameter / 2, 0]);
  const rings = range(o.sides).map((i) => {
    const cx = Math.sin(((i + offset) / o.sides) * Math.PI * 2);
    const cz = Math.cos(((i + offset) / o.sides) * Math.PI * 2);
    return range(sides / 2 - 1).map((n) => n + 1).flatMap((j) => {
      const slice = Math.sin((j / sides) * Math.PI * 2) * (o.diameter / 2) * factor;
      const y = Math.cos((j / sides) * Math.PI * 2) * (o.diameter / 2);
      return d.addVertices([cx * slice, y, cz * slice]);
    });
  });
  range(o.sides).forEach((i) => {
    const here = rings[i] ?? [];
    const next = rings[i + 1] ?? rings[0] ?? [];
    range(sides / 2).forEach((j) => {
      if (j === 0) {
        d.addFaces(makeFace([must(here[0]), must(next[0]), must(top)]));
        return;
      }
      if (here[j] === undefined) {
        d.addFaces(makeFace([must(next[j - 1]), must(here[j - 1]), must(bottom)]));
        return;
      }
      d.addFaces(makeFace([must(here[j]), must(next[j]), must(here[j - 1]), must(next[j - 1])]));
    });
  });
}

/**
 * The hedron branch: walks three's position buffer, reusing a vertex key when
 * an identical position already exists, and makes a triangle from every three
 * entries. The initial UVs copy Blockbench, which reads them from the position
 * array (`uv_array = position.array`), so Auto UV afterwards starts from the
 * same state; Auto UV replaces them.
 */
function hedron(d: MeshDraft, o: IPrimitiveOptions, shape: HedronShape): void {
  const positions = polyhedronTriangles(shape, o.diameter, o.detail);
  const flat = positions.flat();
  const keyFor = (position: Vec3): string => {
    const found = [...d.vertices.entries()].find(([, v]) => v[0] === position[0] && v[1] === position[1] && v[2] === position[2]);
    return found ? found[0] : must(d.addVertices(position)[0]);
  };
  range(positions.length / 3).forEach((t) => {
    const indices = [3 * t, 3 * t + 1, 3 * t + 2];
    const keys = indices.map((i) => keyFor(positions[i] ?? [0, 0, 0]));
    const uv = Object.fromEntries(indices.map((i, n) => [keys[n], [flat[i * 2] ?? 0, flat[i * 2 + 1] ?? 0] as Vec2]));
    d.addFaces(makeFace(keys, uv));
  });
}

function cuboid(d: MeshDraft, o: IPrimitiveOptions): void {
  const r = o.diameter / 2;
  const h = o.height;
  const k = d.addVertices([r, h, r], [r, h, -r], [r, 0, r], [r, 0, -r], [-r, h, r], [-r, h, -r], [-r, 0, r], [-r, 0, -r]);
  const f = (...indices: number[]) => makeFace(indices.map((i) => must(k[i])));
  d.addFaces(f(0, 2, 1, 3), f(4, 5, 6, 7), f(0, 1, 4, 5), f(2, 6, 3, 7), f(0, 4, 2, 6), f(1, 3, 5, 7));
}

function beveledCuboid(d: MeshDraft, o: IPrimitiveOptions): void {
  const s = o.edge_size;
  const rs = o.diameter / 2 - s;
  const r = o.diameter / 2;
  const h = o.height;
  const hs = o.height - s;
  const up = d.addVertices([rs, h, rs], [rs, h, -rs], [-rs, h, rs], [-rs, h, -rs]);
  const down = d.addVertices([rs, 0, rs], [rs, 0, -rs], [-rs, 0, rs], [-rs, 0, -rs]);
  const west = d.addVertices([-r, s, rs], [-r, hs, rs], [-r, s, -rs], [-r, hs, -rs]);
  const east = d.addVertices([r, s, rs], [r, hs, rs], [r, s, -rs], [r, hs, -rs]);
  const north = d.addVertices([rs, s, -r], [rs, hs, -r], [-rs, s, -r], [-rs, hs, -r]);
  const south = d.addVertices([rs, s, r], [rs, hs, r], [-rs, s, r], [-rs, hs, r]);
  const f = (...keys: (string | undefined)[]) => makeFace(keys.map(must));
  d.addFaces(
    f(east[1], east[0], east[3], east[2]), f(west[0], west[1], west[3], west[2]), f(up[0], up[1], up[3], up[2]),
    f(down[1], down[0], down[3], down[2]), f(south[0], south[1], south[3], south[2]), f(north[1], north[0], north[3], north[2]),
  );
  d.addFaces(
    f(up[1], up[0], east[1], east[3]), f(up[2], up[3], west[1], west[3]), f(up[0], up[2], south[1], south[3]), f(up[3], up[1], north[1], north[3]),
    f(down[0], down[1], east[0], east[2]), f(down[3], down[2], west[0], west[2]), f(down[2], down[0], south[0], south[2]), f(down[1], down[3], north[0], north[2]),
    f(north[0], north[1], east[2], east[3]), f(south[1], south[0], east[0], east[1]), f(north[3], north[2], west[2], west[3]), f(south[2], south[3], west[0], west[1]),
  );
  d.addFaces(
    f(down[0], east[0], south[0]), f(down[2], south[2], west[0]), f(down[1], north[0], east[2]), f(down[3], west[2], north[2]),
    f(up[0], south[1], east[1]), f(up[2], west[1], south[3]), f(up[1], east[3], north[1]), f(up[3], north[3], west[3]),
  );
}

function pyramid(d: MeshDraft, o: IPrimitiveOptions): void {
  const r = o.diameter / 2;
  const k = d.addVertices([0, o.height, 0], [r, 0, r], [r, 0, -r], [-r, 0, r], [-r, 0, -r]);
  const f = (...indices: number[]) => makeFace(indices.map((i) => must(k[i])));
  d.addFaces(f(1, 3, 2, 4), f(1, 2, 0), f(3, 1, 0), f(2, 4, 0), f(4, 3, 0));
}

function plane(d: MeshDraft, o: IPrimitiveOptions): void {
  const r = o.diameter / 2;
  const k = d.addVertices([r, 0, r], [r, 0, -r], [-r, 0, r], [-r, 0, -r]);
  d.addFaces(makeFace([must(k[0]), must(k[1]), must(k[3]), must(k[2])]));
}

const BUILDERS: Readonly<Record<PrimitiveShape, (d: MeshDraft, o: IPrimitiveOptions) => void>> = {
  cuboid,
  beveled_cuboid: beveledCuboid,
  pyramid,
  plane,
  circle,
  cylinder,
  tube,
  cone,
  sphere,
  icosphere: (d, o) => hedron(d, o, "icosphere"),
  octahedron: (d, o) => hedron(d, o, "octahedron"),
  dodecahedron: (d, o) => hedron(d, o, "dodecahedron"),
  torus,
};

/** Whether a shape is built from a three.js polyhedron. */
export const isHedron = (shape: PrimitiveShape): shape is HedronShape => (HEDRON_SHAPES as readonly string[]).includes(shape);

/**
 * Builds a primitive exactly like the Add Mesh dialog, then runs Auto UV on all faces.
 *
 * @param options - Dialog fields; see {@link PRIMITIVE_DEFAULTS}.
 * @param uvSize - UV space for Auto UV's overflow correction (the project resolution).
 * @returns The geometry and Blockbench's default name (the shape id, or `mesh` for `cuboid`).
 */
export function buildPrimitive(options: IPrimitiveOptions, uvSize: UvSize): IPrimitiveResult {
  const draft = MeshDraft.from(EMPTY_GEOMETRY);
  BUILDERS[options.shape](draft, options);
  const raw = draft.toGeometry();
  const geometry = autoUvFaces(raw, Object.keys(raw.faces), () => uvSize);
  return { name: options.shape === "cuboid" ? "mesh" : options.shape, geometry };
}
