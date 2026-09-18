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
