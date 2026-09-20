/// <reference types="blockbench-types" />
import { runUndoableEdit } from "@/lib/undo";

/** Texture and outliner parent resolved once per creation batch, before any undo state exists. */
export interface IMeshCreationContext {
  /** Texture applied to every face of each new mesh; falsy when there is none to apply. */
  projectTexture: Texture | null | undefined;
  /** Outliner parent for every new mesh. */
  outlinerGroup: Group | "root";
}

/** Placement fields shared by place_mesh, create_sphere, and create_cylinder elements. */
export interface INewMeshElement {
  name: string;
  /** Mesh origin as a length-3 schema vector. */
  position: number[];
  /** Euler rotation in degrees as a length-3 schema vector; defaults to no rotation. */
  rotation?: number[];
}

/** Local place_mesh geometry: per-axis scale, vertex positions, and faces as vertex indices. */
export interface IIndexedGeometry {
  scale: number[];
  vertices: number[][];
  faces: number[][];
}

/** Keys created for {@link IIndexedGeometry}, index-aligned with its vertices and faces. */
export interface IIndexedGeometryKeys {
  vertex_keys: string[];
  face_keys: string[];
}

/**
 * Runs a batch mesh creation as one undoable edit, then refreshes the whole canvas.
 *
 * `build` receives the very array registered as the undo `elements` aspect and must
 * append each mesh to it (see {@link addNewMesh}) before initializing it, so a failure
 * part-way through reverts every mesh created so far and leaves no history entry.
 *
 * @typeParam T - Whatever `build` returns (typically one entry per created mesh).
 * @param label - History entry label shown in Blockbench's Edit menu.
 * @param build - Creates the meshes, appending each to the tracked array.
 * @returns The value returned by `build`, after the edit is finished and the canvas updated.
 * @throws The error thrown by `build`, after the pending edit has been reverted.
 */
export function createMeshEdit<T>(label: string, build: (meshes: Mesh[]) => T): T {
  const meshes: Mesh[] = [];
  const result = runUndoableEdit({ elements: meshes, outliner: true, collections: [] }, label, () => build(meshes));
  Canvas.updateAll();
  return result;
}

/** Schema vectors are length-validated number arrays; Blockbench expects its tuple type. */
function toArrayVector3(vector: number[]): ArrayVector3 {
  return [vector[0], vector[1], vector[2]];
}

/**
 * Creates one mesh inside a {@link createMeshEdit} build.
 *
 * The mesh is appended to `created` before any geometry exists (so undo tracks it
 * even if geometry or initialization fails), then `addGeometry` runs, and the mesh
 * is parented, initialized, and textured on every face.
 *
 * @typeParam T - Value produced by `addGeometry`, such as created keys.
 * @param created - The tracked array passed to the `createMeshEdit` builder.
 * @param element - Name and transform of the new mesh.
 * @param creation - Resolved texture and outliner parent.
 * @param addGeometry - Adds vertices and faces to the empty mesh.
 * @returns A tuple of the initialized mesh and `addGeometry`'s result.
 */
export function addNewMesh<T>(created: Mesh[], element: INewMeshElement, creation: IMeshCreationContext, addGeometry: (mesh: Mesh) => T): [Mesh, T] {
  const mesh = new Mesh({
    name: element.name,
    vertices: {},
    origin: toArrayVector3(element.position),
    rotation: toArrayVector3(element.rotation ?? [0, 0, 0]),
  });
  created.push(mesh);
  const geometry = addGeometry(mesh);
  mesh.addTo(creation.outlinerGroup).init();
  if (creation.projectTexture) mesh.applyTexture(creation.projectTexture, true);
  return [mesh, geometry];
}

/**
 * Adds scaled local vertices and indexed triangle/quad faces to an empty mesh.
 *
 * Face indices must already be validated as distinct and in range. Faces carry empty UVs.
 *
 * @param mesh - Freshly constructed mesh inside a tracked creation edit.
 * @param geometry - Vertices (scaled per axis by `scale`) and faces as indices into them.
 * @returns Created keys in input order, so clients can map indices to runtime keys.
 */
export function addIndexedGeometry(mesh: Mesh, geometry: IIndexedGeometry): IIndexedGeometryKeys {
  const vertexKeys = geometry.vertices.map((vertex) => mesh.addVertices([
    vertex[0] * geometry.scale[0],
    vertex[1] * geometry.scale[1],
    vertex[2] * geometry.scale[2],
  ])[0]);
  const faceKeys = geometry.faces.map((face) => mesh.addFaces(new MeshFace(mesh, {
    vertices: face.map((vertexIndex) => vertexKeys[vertexIndex]),
    uv: {},
  }))[0]);
  return { vertex_keys: vertexKeys, face_keys: faceKeys };
}

/** Geometry inputs for a UV sphere, matching the parsed `create_sphere` element fields. */
export interface ISphereGeometryOptions {
  /** Sphere diameter in local model units. */
  diameter: number;
  /** Radial ring count; the latitude count is this value rounded to an even number. */
  sides: number;
  /** When true, rotates rings by half a segment so edges align with the model axes. */
  align_edges: boolean;
}

/** Geometry inputs for a cylinder, matching the parsed `create_cylinder` element fields. */
export interface ICylinderGeometryOptions {
  /** Height along the local Y axis, centered on the origin. */
  height: number;
  /** Diameter in local model units. */
  diameter: number;
  /** Number of radial segments. */
  sides: number;
  /** When true, closes both ends with outward-facing triangle fans. */
  capped: boolean;
}

function addFacesFromVertexLists(mesh: Mesh, vertexLists: string[][]): void {
  vertexLists.forEach((vertices) => mesh.addFaces(new MeshFace(mesh, { vertices, uv: {} })));
}

/** Creates one meridian ring (excluding poles) at longitude index `ring`, top to bottom. */
function addSphereRing(mesh: Mesh, ring: number, latitudes: number, radius: number, options: ISphereGeometryOptions): string[] {
  const offset = options.align_edges ? 0.5 : 0;
  // Keep the exact expression order so generated coordinates stay bit-identical.
  const circleX = Math.sin(((ring + offset) / options.sides) * Math.PI * 2);
  const circleZ = Math.cos(((ring + offset) / options.sides) * Math.PI * 2);
  return Array.from({ length: latitudes / 2 - 1 }, (_, index) => {
    const step = index + 1;
    const sliceX = Math.sin((step / latitudes) * Math.PI * 2) * radius;
    const y = Math.cos((step / latitudes) * Math.PI * 2) * radius;
    return mesh.addVertices([circleX * sliceX, y, circleZ * sliceX])[0];
  });
}

/** Vertex keys for the face at latitude `step` between two neighboring rings: top fan, quad band, or bottom fan. */
function sphereFaceVertices(thisRing: string[], nextRing: string[], step: number, top: string, bottom: string): string[] {
  if (step === 0) return [thisRing[step], nextRing[step], top];
  if (!thisRing[step]) return [nextRing[step - 1], thisRing[step - 1], bottom];
  return [thisRing[step], nextRing[step], thisRing[step - 1], nextRing[step - 1]];
}

/**
 * Adds UV-sphere vertices and faces to an empty mesh using spherical coordinates.
 *
 * Creates the bottom and top poles, then `sides` rings of `latitudes / 2 - 1` vertices
 * (where `latitudes` is `sides` rounded to an even number for symmetry), then all faces
 * ring by ring. Faces carry empty UVs; callers apply textures/UV mapping afterward.
 *
 * @param mesh - Freshly constructed mesh; must be inside an undo edit that tracks it.
 * @param options - Parsed sphere dimensions and segmentation.
 */
export function addSphereGeometry(mesh: Mesh, options: ISphereGeometryOptions): void {
  const radius = options.diameter / 2;
  const latitudes = Math.round(options.sides / 2) * 2;
  const [bottom] = mesh.addVertices([0, -radius, 0]);
  const [top] = mesh.addVertices([0, radius, 0]);
  const rings = Array.from({ length: options.sides }, (_, ring) => addSphereRing(mesh, ring, latitudes, radius, options));
  const faces = rings.flatMap((thisRing, ring) => {
    const nextRing = rings[ring + 1] || rings[0];
    return Array.from({ length: latitudes / 2 }, (_, step) => sphereFaceVertices(thisRing, nextRing, step, top, bottom));
  });
  addFacesFromVertexLists(mesh, faces);
}

/** Vertex keys of a cylinder's top and bottom rings, index-aligned per radial segment. */
interface ICylinderRings {
  top: string[];
  bottom: string[];
}

/** Creates the top/bottom vertex pair for each radial segment, interleaved per segment. */
function addCylinderRings(mesh: Mesh, options: ICylinderGeometryOptions, sides: number): ICylinderRings {
  const radius = options.diameter / 2;
  const halfHeight = options.height / 2;
  const pairs = Array.from({ length: sides }, (_, index) => {
    // Evaluated as ((index / sides) * PI) * 2; regrouping would change low-order bits.
    const angle = (index / sides) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const [top] = mesh.addVertices([x, halfHeight, z]);
    const [bottom] = mesh.addVertices([x, -halfHeight, z]);
    return { top, bottom };
  });
  return { top: pairs.map((pair) => pair.top), bottom: pairs.map((pair) => pair.bottom) };
}

/**
 * Adds cylinder vertices and faces to an empty mesh, centered on the local origin.
 *
 * Cap centers are created only when `capped`, so open tubes have no unused vertices.
 * For each segment the side quad is added, followed by the top and bottom cap
 * triangles; windings face outward. Faces carry empty UVs.
 *
 * @param mesh - Freshly constructed mesh; must be inside an undo edit that tracks it.
 * @param options - Parsed cylinder dimensions, segmentation, and capping.
 */
export function addCylinderGeometry(mesh: Mesh, options: ICylinderGeometryOptions): void {
  const sides = Math.round(options.sides);
  const [topCenter, bottomCenter] = options.capped ? mesh.addVertices([0, options.height / 2, 0], [0, -options.height / 2, 0]) : [];
  const { top, bottom } = addCylinderRings(mesh, options, sides);
  const faces = top.flatMap((current, index) => {
    const next = (index + 1) % sides;
    const side = [current, top[next], bottom[next], bottom[index]];
    if (!options.capped) return [side];
    return [side, [top[next], current, topCenter], [bottom[index], bottom[next], bottomCenter]];
  });
  addFacesFromVertexLists(mesh, faces);
}

// ============================================================================
// Regular polyhedra (Blockbench 5.2 add_primitive: icosphere, octahedron, dodecahedron)
// ============================================================================

/** Polyhedron primitives added to Blockbench 5.2's Add Mesh dialog. */
export const POLYHEDRON_SHAPES = ["icosphere", "octahedron", "dodecahedron"] as const;

/** One of {@link POLYHEDRON_SHAPES}. */
export type PolyhedronShape = typeof POLYHEDRON_SHAPES[number];

/** Highest subdivision level accepted by Blockbench's dialog. */
export const MAX_POLYHEDRON_DETAIL = 6;

/** Geometry inputs for {@link buildPolyhedronGeometry}. */
export interface IPolyhedronOptions {
  shape: PolyhedronShape;
  /** Circumscribed sphere diameter in local model units (every vertex lies at diameter / 2). */
  diameter: number;
  /** Subdivision level 0-6: each base triangle is split into (detail + 1)^2 triangles. */
  detail: number;
}

/** A local-space point as `[x, y, z]`. */
export type Point3 = [number, number, number];

/** Indexed triangle mesh with per-face UV corners, independent of Blockbench. */
export interface IPolyhedronGeometry {
  /** Unique vertex positions (merged by position). */
  vertices: Point3[];
  /** Triangles as indices into `vertices`, wound counter-clockwise seen from outside. */
  faces: [number, number, number][];
  /** Per-face UV corners, index-aligned with `faces` and each face's vertex order. */
  uvs: [number, number][][];
}

/** Base vertex/index tables from three.js r134 (`*Geometry` classes), used by Blockbench 5.2. */
interface IPolyhedronBase {
  vertices: readonly number[];
  indices: readonly number[];
}

const PHI = (1 + Math.sqrt(5)) / 2;
const INV_PHI = 1 / PHI;

const POLYHEDRON_BASES: Readonly<Record<PolyhedronShape, IPolyhedronBase>> = {
  icosphere: {
    vertices: [-1, PHI, 0, 1, PHI, 0, -1, -PHI, 0, 1, -PHI, 0, 0, -1, PHI, 0, 1, PHI, 0, -1, -PHI, 0, 1, -PHI, PHI, 0, -1, PHI, 0, 1, -PHI, 0, -1, -PHI, 0, 1],
    indices: [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1],
  },
  octahedron: {
    vertices: [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1],
    indices: [0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 3, 1, 3, 4, 1, 4, 2],
  },
  dodecahedron: {
    vertices: [
      -1, -1, -1, -1, -1, 1, -1, 1, -1, -1, 1, 1, 1, -1, -1, 1, -1, 1, 1, 1, -1, 1, 1, 1,
      0, -INV_PHI, -PHI, 0, -INV_PHI, PHI, 0, INV_PHI, -PHI, 0, INV_PHI, PHI,
      -INV_PHI, -PHI, 0, -INV_PHI, PHI, 0, INV_PHI, -PHI, 0, INV_PHI, PHI, 0,
      -PHI, 0, -INV_PHI, PHI, 0, -INV_PHI, -PHI, 0, INV_PHI, PHI, 0, INV_PHI,
    ],
    indices: [
      3, 11, 7, 3, 7, 15, 3, 15, 13, 7, 19, 17, 7, 17, 6, 7, 6, 15, 17, 4, 8, 17, 8, 10, 17, 10, 6,
      8, 0, 16, 8, 16, 2, 8, 2, 10, 0, 12, 1, 0, 1, 18, 0, 18, 16, 6, 10, 2, 6, 2, 13, 6, 13, 15,
      2, 16, 18, 2, 18, 3, 2, 3, 13, 18, 1, 9, 18, 9, 11, 18, 11, 3, 4, 14, 12, 4, 12, 0, 4, 0, 8,
      11, 9, 5, 11, 5, 19, 11, 19, 7, 19, 5, 14, 19, 14, 4, 19, 4, 17, 1, 12, 14, 1, 14, 5, 1, 5, 9,
    ],
  },
};

/** Decimal places used to merge coincident vertices after projection. */
const POLYHEDRON_MERGE_DECIMALS = 6;

const lerpPoint = (a: Point3, b: Point3, t: number): Point3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const subtract = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point3, b: Point3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point3, b: Point3): Point3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scalePoint = (a: Point3, factor: number): Point3 => [a[0] * factor, a[1] * factor, a[2] * factor];
const normalize = (a: Point3): Point3 => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length === 0 ? a : scalePoint(a, 1 / length);
};

/**
 * Splits triangle `a, b, c` into `(detail + 1)^2` triangles exactly like three.js
 * `PolyhedronGeometry.subdivideFace`, preserving its counter-clockwise winding.
 */
function subdivideTriangle(a: Point3, b: Point3, c: Point3, detail: number): Point3[][] {
  const cols = detail + 1;
  const grid = Array.from({ length: cols + 1 }, (_, i) => {
    const aj = lerpPoint(a, c, i / cols);
    const bj = lerpPoint(b, c, i / cols);
    const rows = cols - i;
    return Array.from({ length: rows + 1 }, (_, j) => (rows === 0 ? aj : lerpPoint(aj, bj, j / rows)));
  });
  return Array.from({ length: cols }, (_, i) => i).flatMap((i) =>
    Array.from({ length: 2 * (cols - i) - 1 }, (_, j) => {
      const k = Math.floor(j / 2);
      return j % 2 === 0
        ? [grid[i][k + 1], grid[i + 1][k], grid[i][k]]
        : [grid[i][k + 1], grid[i + 1][k + 1], grid[i + 1][k]];
    }));
}

/**
 * Planar auto-UV for one face: projects its corners onto the face plane (u along
 * the first edge), then shifts so the minimum corner sits at `[0, 0]` with v
 * growing downward like texture space. One UV unit per model unit, as Blockbench's
 * mesh auto-size produces for a 16px-per-block texture.
 *
 * @param corners - Face corners in winding order (at least three, non-collinear).
 * @returns UV per corner, index-aligned with `corners`.
 */
export function planarFaceUv(corners: readonly Point3[]): [number, number][] {
  const origin = corners[0];
  const uAxis = normalize(subtract(corners[1], origin));
  const normal = normalize(cross(subtract(corners[1], origin), subtract(corners[2], origin)));
  const vAxis = cross(normal, uAxis);
  const projected = corners.map((corner): [number, number] => {
    const offset = subtract(corner, origin);
    return [dot(offset, uAxis), dot(offset, vAxis)];
  });
  const minU = Math.min(...projected.map(([u]) => u));
  const maxV = Math.max(...projected.map(([, v]) => v));
  return projected.map(([u, v]) => [u - minU, maxV - v]);
}

/** Rounds a coordinate for vertex merging, folding `-0` into `0`. */
function mergeKey(point: Point3): string {
  return point.map((value) => (Math.abs(value) < 10 ** -POLYHEDRON_MERGE_DECIMALS ? 0 : value).toFixed(POLYHEDRON_MERGE_DECIMALS)).join(",");
}

/**
 * Builds an icosphere, octahedron, or dodecahedron like Blockbench 5.2's
 * add_primitive dialog (three.js polyhedron tables, subdivided by `detail`,
 * projected onto a sphere, vertices merged by position), with two deliberate
 * differences: `diameter` is a true diameter (Blockbench hands it to three.js as
 * the radius), and UVs are planar per face instead of Blockbench's
 * position-derived UVs, which read the wrong buffer. Pure; no Blockbench globals.
 *
 * @param options - Shape, diameter, and subdivision detail (0-6).
 * @returns Merged vertices, CCW triangles, and per-face UVs.
 * @throws When `detail` is not an integer in 0-6 or `diameter` is not positive and finite.
 */
export function buildPolyhedronGeometry(options: IPolyhedronOptions): IPolyhedronGeometry {
  if (!Number.isInteger(options.detail) || options.detail < 0 || options.detail > MAX_POLYHEDRON_DETAIL) {
    throw new Error(`Polyhedron detail must be an integer from 0 to ${MAX_POLYHEDRON_DETAIL}.`);
  }
  if (!Number.isFinite(options.diameter) || options.diameter <= 0) throw new Error("Polyhedron diameter must be a positive finite number.");
  const base = POLYHEDRON_BASES[options.shape];
  const radius = options.diameter / 2;
  const basePoints = Array.from({ length: base.vertices.length / 3 }, (_, index): Point3 =>
    [base.vertices[index * 3], base.vertices[index * 3 + 1], base.vertices[index * 3 + 2]]);
  const triangles = Array.from({ length: base.indices.length / 3 }, (_, index) => index * 3).flatMap((offset) =>
    subdivideTriangle(basePoints[base.indices[offset]], basePoints[base.indices[offset + 1]], basePoints[base.indices[offset + 2]], options.detail)
      .map((triangle) => triangle.map((point) => scalePoint(normalize(point), radius))));

  // Vertices are ordered by first occurrence, and the first position seen for a key is kept.
  const corners = triangles.flat();
  const uniqueKeys = [...new Set(corners.map(mergeKey))];
  const indexByKey = new Map(uniqueKeys.map((key, index) => [key, index] as const));
  const positionByKey = new Map(corners.toReversed().map((point) => [mergeKey(point), point] as const));
  const vertices = uniqueKeys.map((key): Point3 => positionByKey.get(key) ?? [0, 0, 0]);
  const faces = triangles.map((triangle) => triangle.map((point) => indexByKey.get(mergeKey(point)) ?? 0) as [number, number, number]);
  const uvs = faces.map((face) => planarFaceUv(face.map((index) => vertices[index])));
  return { vertices, faces, uvs };
}

/**
 * Adds a {@link buildPolyhedronGeometry} result to an empty mesh inside a tracked
 * creation edit, writing the planar UVs onto each triangle.
 *
 * @param mesh - Freshly constructed mesh; must be inside an undo edit that tracks it.
 * @param options - Shape, diameter, and detail.
 * @returns Created vertex and face keys in geometry order.
 */
export function addPolyhedronGeometry(mesh: Mesh, options: IPolyhedronOptions): IIndexedGeometryKeys {
  const geometry = buildPolyhedronGeometry(options);
  const vertexKeys = geometry.vertices.map((vertex) => mesh.addVertices(vertex)[0]);
  const faceKeys = geometry.faces.map((face, faceIndex) => {
    const keys = face.map((vertexIndex) => vertexKeys[vertexIndex]);
    const uv = Object.fromEntries(keys.map((key, corner) => [key, geometry.uvs[faceIndex][corner]]));
    return mesh.addFaces(new MeshFace(mesh, { vertices: keys, uv }))[0];
  });
  return { vertex_keys: vertexKeys, face_keys: faceKeys };
}
