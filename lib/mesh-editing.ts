/// <reference types="blockbench-types" />
import { GEOMETRY_EPSILON, MAX_SUBDIVISION_CUTS } from "@/lib/constants";
import { runUndoableEdit } from "@/lib/undo";

type Vector = [number, number, number];
type UV = [number, number];
/** Integer `[i, j]` lattice coordinate inside one subdivided face. */
type GridCoordinate = [number, number];

/** Runtime shape of `Project.mesh_selection[uuid]`; edges are vertex-key pairs. */
interface IMeshSelection {
  vertices: string[];
  edges: string[][];
  faces: string[];
}

/**
 * Keys produced by a topology edit, returned to MCP clients so follow-up tools
 * (selection, UV, further edits) can target the new geometry directly.
 */
export interface IMeshEditResult {
  /** Newly created vertex keys, in creation order. */
  vertex_keys: string[];
  /** Face keys that make up the edited region (retained caps plus created faces). */
  face_keys: string[];
}

/** Counts reported after component deletion so clients can confirm the scope of the change. */
export interface IMeshDeleteResult {
  /** Vertices removed, including orphans unless they were kept. */
  deleted_vertices: number;
  /** Faces removed, including faces incident to deleted edges or vertices. */
  deleted_faces: number;
}

/** A selected face captured before editing, with its perimeter in winding order. */
interface IFaceSource {
  key: string;
  face: MeshFace;
  vertices: string[];
}

/** One directed perimeter edge of a selected face, with its undirected lookup key. */
interface IFaceEdge {
  source: IFaceSource;
  a: string;
  b: string;
  key: string;
}

/** A subdivision lattice point: the shared vertex key and the UV interpolated for its source face. */
interface IGridPoint {
  key: string;
  uv: UV;
}

/** A face corner whose barycentric/bilinear weight contributes to a lattice point. */
interface ICornerWeight {
  corner: string;
  weight: number;
}

/** Per-face inputs shared by the subdivision helpers. */
interface ISubdivisionContext {
  mesh: Mesh;
  faceKey: string;
  source: MeshFace;
  corners: string[];
  segments: number;
  triangle: boolean;
  /** Cross-face cache so neighbors reuse boundary vertices; values are created vertices in creation order. */
  edgeVertices: Map<string, string>;
}

/** Fallback UV for face corners that carry no stored coordinates. */
const DEFAULT_UV: Readonly<UV> = [0, 0];

/**
 * Resolves the polygon keys an edit should target, validating them before any undo state exists.
 *
 * @param mesh - Mesh whose faces are resolved.
 * @param requested - Explicit face keys; when omitted, the mesh's current face selection is used.
 * @returns Unique face keys in first-seen order.
 * @throws When no faces resolve, or when a key is missing, has fewer than three vertices,
 *   or references a vertex that no longer exists.
 */
export function resolveMeshFaces(mesh: Mesh, requested?: string[]): string[] {
  const keys = [...new Set(requested ?? mesh.getSelectedFaces())];
  if (!keys.length) throw new Error("No faces selected. Use select_mesh_elements with returned face keys, or provide faces.");
  const invalid = keys.find(key => {
    const face = mesh.faces[key];
    return !face || face.vertices.length < 3 || face.vertices.some(vertex => !mesh.vertices[vertex]);
  });
  if (invalid !== undefined) throw new Error(`Face "${invalid}" is missing or is not a valid polygon.`);
  return keys;
}

/**
 * Runs one targeted geometry/UV mutation as a single undo entry and refreshes the preview.
 *
 * The full mesh plus selection is snapshotted either way, so geometry and UVs are always
 * restorable. The preview refresh happens inside the transaction: if the mutation or the
 * refresh throws, the pending edit is canceled with revert and the error is rethrown.
 *
 * @typeParam T - Value produced by `mutate`, passed through unchanged.
 * @param mesh - The only element captured by the undo snapshot and refreshed afterward.
 * @param label - History entry label shown in Blockbench's Edit menu.
 * @param mutate - Mutation to apply to `mesh`.
 * @param uvOnly - When true, skips the geometry refresh and updates only UVs/faces.
 * @returns The value returned by `mutate`.
 * @throws The original mutation/refresh error after reverting (see `runUndoableEdit`).
 */
export function editMesh<T>(mesh: Mesh, label: string, mutate: () => T, uvOnly = false): T {
  return runUndoableEdit({ elements: [mesh], selection: true }, label, () => {
    const result = mutate();
    Canvas.updateView({ elements: [mesh], element_aspects: { geometry: !uvOnly, uv: true, faces: true }, selection: true });
    return result;
  });
}

function selectionMap(): Record<string, IMeshSelection> {
  if (!Project) throw new Error("No project is open.");
  // Published host types incorrectly describe edges as string[]; runtime uses key pairs.
  return Project.mesh_selection as unknown as Record<string, IMeshSelection>;
}

function selection(mesh: Mesh): IMeshSelection {
  return selectionMap()[mesh.uuid] ??= { vertices: [], edges: [], faces: [] };
}

function getOrThrow<K, V>(map: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Internal mesh edit error: missing ${label} for "${String(key)}".`);
  return value;
}

function copyUV(uv: Readonly<UV> | undefined): UV {
  const [u, v] = uv ?? DEFAULT_UV;
  return [u, v];
}

function copyFace(mesh: Mesh, source: MeshFace, vertices: string[], uv: Record<string, UV>): string {
  return mesh.addFaces(new MeshFace(mesh, source).extend({ vertices, uv }))[0];
}

function edgeKey(a: string, b: string): string {
  return JSON.stringify([a, b].toSorted());
}

function removeUnreferencedVertices(mesh: Mesh, candidates: string[]): void {
  const referenced = new Set(Object.values(mesh.faces).flatMap(face => face.vertices));
  candidates.filter(key => !referenced.has(key)).forEach(key => { delete mesh.vertices[key]; });
}

function averagedUnitNormal(key: string, sources: IFaceSource[]): Vector {
  const sum = sources.filter(source => source.vertices.includes(key)).reduce<Vector>((value, source) => {
    const normal = source.face.getNormal(true);
    return [value[0] + normal[0], value[1] + normal[1], value[2] + normal[2]];
  }, [0, 0, 0]);
  const length = Math.hypot(...sum);
  if (!Number.isFinite(length) || length < GEOMETRY_EPSILON) throw new Error(`Cannot extrude vertex "${key}": selected face normals cancel or are degenerate.`);
  return [sum[0] / length, sum[1] / length, sum[2] / length];
}

function offsetAlong(position: Readonly<Vector>, normal: Readonly<Vector>, distance: number): Vector {
  return [position[0] + normal[0] * distance, position[1] + normal[1] * distance, position[2] + normal[2] * distance];
}

function perimeterEdges(source: IFaceSource): IFaceEdge[] {
  return source.vertices.map((a, index) => {
    const b = source.vertices[(index + 1) % source.vertices.length];
    return { source, a, b, key: edgeKey(a, b) };
  });
}

function addWallFace(mesh: Mesh, { source, a, b }: IFaceEdge, replace: (key: string) => string, distance: number): string {
  const nextA = replace(a);
  const nextB = replace(b);
  const uvA = source.face.uv[a] ?? DEFAULT_UV;
  const uvB = source.face.uv[b] ?? DEFAULT_UV;
  return copyFace(mesh, source.face, [a, b, nextB, nextA], {
    [a]: copyUV(uvA), [b]: copyUV(uvB), [nextB]: [uvB[0], uvB[1] + distance], [nextA]: [uvA[0], uvA[1] + distance],
  });
}

/**
 * Extrudes the selected face region along averaged unit vertex normals.
 *
 * Selected faces are moved to the new vertices (retaining their keys as caps), a
 * wall quad is added for every boundary edge, and originals no longer referenced are
 * removed. The result becomes the new component selection.
 *
 * @param mesh - Mesh whose current face selection is extruded.
 * @param distance - Signed offset along the normals, in local model units.
 * @returns New vertex keys, and the cap face keys followed by the created wall face keys.
 * @throws When the selection is empty/stale, `distance` is zero or non-finite, normals
 *   cancel out, or the region is non-manifold (an edge shared by more than two faces).
 */
export function extrudeMeshFaces(mesh: Mesh, distance: number): IMeshEditResult {
  const keys = resolveMeshFaces(mesh);
  if (!Number.isFinite(distance) || distance === 0) throw new Error("Extrusion distance must be finite and nonzero.");
  const sources = keys.map(key => ({ key, face: mesh.faces[key], vertices: mesh.faces[key].getSortedVertices() }));
  const originals = [...new Set(sources.flatMap(source => source.vertices))];
  const normals = originals.map(key => averagedUnitNormal(key, sources));
  const edges = sources.flatMap(perimeterEdges);
  const counts = edges.reduce((map, edge) => map.set(edge.key, (map.get(edge.key) ?? 0) + 1), new Map<string, number>());
  if ([...counts.values()].some(count => count > 2)) throw new Error("Cannot extrude a non-manifold selected region.");
  return editMesh(mesh, "Extrude mesh faces", () => {
    const newVertices = originals.map((key, index) => mesh.addVertices(offsetAlong(mesh.vertices[key], normals[index], distance))[0]);
    const replacement = new Map(originals.map((key, index) => [key, newVertices[index]]));
    const replace = (key: string): string => getOrThrow(replacement, key, "extruded vertex");
    const created = edges.filter(edge => counts.get(edge.key) === 1).map(edge => addWallFace(mesh, edge, replace, distance));
    sources.forEach(({ face, vertices }) => {
      const uv = Object.fromEntries(vertices.map(key => [replace(key), copyUV(face.uv[key])]));
      face.extend({ vertices: vertices.map(key => replace(key)), uv });
    });
    removeUnreferencedVertices(mesh, originals);
    const selected = selection(mesh);
    selected.vertices = newVertices;
    selected.edges = [];
    selected.faces = keys;
    return { vertex_keys: newVertices, face_keys: [...keys, ...created] };
  });
}

function gridWeights(u: number, v: number, triangle: boolean): number[] {
  return triangle ? [1 - u - v, u, v] : [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v];
}

function gridCoordinates(segments: number, triangle: boolean): GridCoordinate[] {
  return Array.from({ length: segments + 1 }, (_, i) => i).flatMap(i =>
    Array.from({ length: (triangle ? segments - i : segments) + 1 }, (_, j): GridCoordinate => [i, j]));
}

/** Points on a corner or source edge get a face-independent key so neighboring faces share them. */
function gridPointCacheKey(context: ISubdivisionContext, active: ICornerWeight[], [i, j]: GridCoordinate): string {
  if (active.length > 2) return `${context.faceKey}:${i}:${j}`;
  const terms = active.map(({ corner, weight }): [string, number] => [corner, Math.round(weight * context.segments)]);
  return JSON.stringify(terms.toSorted((a, b) => a[0].localeCompare(b[0])));
}

function resolveGridPoint(context: ISubdivisionContext, coordinate: GridCoordinate): IGridPoint {
  const { mesh, source, corners, segments, edgeVertices } = context;
  const weights = gridWeights(coordinate[0] / segments, coordinate[1] / segments, context.triangle);
  const active = corners.map((corner, index): ICornerWeight => ({ corner, weight: weights[index] })).filter(entry => entry.weight > GEOMETRY_EPSILON);
  const cacheKey = gridPointCacheKey(context, active, coordinate);
  const weighted = (read: (corner: string) => number): number => corners.reduce((sum, corner, index) => sum + read(corner) * weights[index], 0);
  const position = (axis: number): number => weighted(corner => mesh.vertices[corner][axis]);
  const uv = (axis: number): number => weighted(corner => source.uv[corner]?.[axis] ?? 0);
  const createVertex = (): string => {
    const [vertex] = mesh.addVertices([position(0), position(1), position(2)]);
    edgeVertices.set(cacheKey, vertex);
    return vertex;
  };
  const key = (active.length === 1 ? active[0].corner : edgeVertices.get(cacheKey)) ?? createVertex();
  return { key, uv: [uv(0), uv(1)] };
}

function cellPolygons(i: number, j: number, segments: number, triangle: boolean): GridCoordinate[][] {
  if (!triangle) return [[[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]]];
  const lower: GridCoordinate[] = [[i, j], [i + 1, j], [i, j + 1]];
  return i + j < segments - 1 ? [lower, [[i + 1, j], [i + 1, j + 1], [i, j + 1]]] : [lower];
}

function gridCells(segments: number, triangle: boolean): GridCoordinate[][] {
  return Array.from({ length: segments }, (_, i) => i).flatMap(i =>
    Array.from({ length: triangle ? segments - i : segments }, (_, j) => j).flatMap(j => cellPolygons(i, j, segments, triangle)));
}

function subdivideFace(mesh: Mesh, faceKey: string, segments: number, edgeVertices: Map<string, string>): string[] {
  const source = mesh.faces[faceKey];
  const corners = source.getSortedVertices();
  const context: ISubdivisionContext = { mesh, faceKey, source, corners, segments, triangle: corners.length === 3, edgeVertices };
  // Every lattice vertex for this face is resolved (and created) before any child face is added.
  const points = new Map(gridCoordinates(segments, context.triangle)
    .map(([i, j]): [string, IGridPoint] => [`${i}:${j}`, resolveGridPoint(context, [i, j])]));
  const faces = gridCells(segments, context.triangle).map(cell => {
    const values = cell.map(([i, j]) => getOrThrow(points, `${i}:${j}`, "subdivision grid point"));
    const uv = Object.fromEntries(values.map(value => [value.key, value.uv]));
    return copyFace(mesh, source, values.map(value => value.key), uv);
  });
  delete mesh.faces[faceKey];
  return faces;
}

/**
 * Splits selected triangles/quads into a regular grid with `cuts + 1` segments per edge.
 *
 * Vertices on shared source edges are created once and reused by neighboring selected
 * faces; each child face copies its source's material and interpolates its UVs. The
 * child faces and their vertices become the new component selection.
 *
 * @param mesh - Mesh whose current face selection is subdivided.
 * @param cuts - Integer cuts per edge, from 1 to `MAX_SUBDIVISION_CUTS`; each face becomes `(cuts + 1)²` faces.
 * @returns Created vertex keys in creation order, and all child face keys.
 * @throws When the selection is empty/stale, `cuts` is out of range, or a selected face has more than four vertices.
 */
export function subdivideMeshFaces(mesh: Mesh, cuts: number): IMeshEditResult {
  const keys = resolveMeshFaces(mesh);
  if (!Number.isInteger(cuts) || cuts < 1 || cuts > MAX_SUBDIVISION_CUTS) throw new Error(`Subdivision cuts must be an integer from 1 to ${MAX_SUBDIVISION_CUTS}.`);
  if (keys.some(key => mesh.faces[key].vertices.length > 4)) throw new Error("Subdivision supports triangle and quad faces only.");
  const segments = cuts + 1;
  return editMesh(mesh, "Subdivide mesh faces", () => {
    const edgeVertices = new Map<string, string>();
    const createdFaces = keys.flatMap(key => subdivideFace(mesh, key, segments, edgeVertices));
    const selected = selection(mesh);
    selected.faces = createdFaces;
    selected.edges = [];
    selected.vertices = [...new Set(createdFaces.flatMap(key => mesh.faces[key].vertices))];
    return { vertex_keys: [...edgeVertices.values()], face_keys: createdFaces };
  });
}

function findIncidentFaces(mesh: Mesh, mode: "edges" | "vertices", vertices: string[], edges: string[][]): string[] {
  const vertexSet = new Set(vertices);
  const edgeKeys = new Set(edges.map(edge => edgeKey(edge[0], edge[1])));
  const touches = mode === "vertices"
    ? (sorted: string[]) => sorted.some(vertex => vertexSet.has(vertex))
    : (sorted: string[]) => sorted.some((a, index) => edgeKeys.has(edgeKey(a, sorted[(index + 1) % sorted.length])));
  return Object.keys(mesh.faces).filter(key => touches(mesh.faces[key].getSortedVertices()));
}

/**
 * Deletes the mesh's selected components together with every incident face.
 *
 * @param mesh - Mesh whose stored component selection is deleted.
 * @param mode - `"faces"` deletes selected faces; `"edges"` and `"vertices"` delete every
 *   face touching a selected edge/vertex (explicitly selected vertices are always removed).
 * @param keepVertices - When true, vertices orphaned by face/edge removal are retained;
 *   unrelated loose vertices are never touched.
 * @returns How many vertices and faces were removed.
 * @throws When nothing is selected for `mode`, or the selection references missing geometry.
 */
export function deleteMeshSelection(mesh: Mesh, mode: "faces" | "edges" | "vertices", keepVertices: boolean): IMeshDeleteResult {
  const selected: IMeshSelection = selectionMap()[mesh.uuid] ?? { vertices: [], edges: [], faces: [] };
  const vertices = mode === "vertices" ? [...selected.vertices] : [];
  const edges = mode === "edges" ? selected.edges : [];
  const selectedCount = { vertices: vertices.length, edges: edges.length, faces: selected.faces.length }[mode];
  if (!selectedCount) throw new Error(`No ${mode} selected. Use select_mesh_elements before deleting components.`);
  const faces = mode === "faces" ? [...selected.faces] : findIncidentFaces(mesh, mode, vertices, edges);
  const missingGeometry = faces.some(key => !mesh.faces[key])
    || vertices.some(key => !mesh.vertices[key])
    || edges.some(edge => edge.length !== 2 || edge.some(key => !mesh.vertices[key]));
  if (missingGeometry) throw new Error("Mesh selection contains missing geometry. Select current keys from get_mesh_info.");
  const candidates = new Set([...vertices, ...edges.flat(), ...faces.flatMap(key => mesh.faces[key].vertices)]);
  const explicitVertices = new Set(vertices);
  const deletedEdges = new Set(edges);
  return editMesh(mesh, `Delete mesh ${mode}`, () => {
    faces.forEach(key => { delete mesh.faces[key]; });
    const referenced = new Set(Object.values(mesh.faces).flatMap(face => face.vertices));
    const removed = [...candidates].filter(key => explicitVertices.has(key) || (!keepVertices && !referenced.has(key)));
    removed.forEach(key => { delete mesh.vertices[key]; });
    selected.vertices = selected.vertices.filter(key => !!mesh.vertices[key]);
    selected.faces = selected.faces.filter(key => !!mesh.faces[key]);
    selected.edges = selected.edges.filter(edge => edge.every(key => !!mesh.vertices[key]) && !deletedEdges.has(edge));
    return { deleted_vertices: removed.length, deleted_faces: faces.length };
  });
}
