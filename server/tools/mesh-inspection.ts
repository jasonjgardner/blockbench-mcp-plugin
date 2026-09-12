import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { getMeshOrSelected } from "@/lib/util";

/**
 * Read-only mesh inspection parameters. Independent vertex and face offsets page
 * through lexicographically sorted runtime keys, with at most 500 items per list.
 * Mesh lookup uses a UUID/name, or the first selected mesh when omitted.
 */
export const getMeshInfoParameters = z.object({
  mesh_id: z.string().min(1).optional().describe("Mesh UUID or name. Omit to inspect the first selected mesh."),
  include_vertices: z.boolean().default(true).describe("Include a page of vertex keys, local positions, and selection flags."),
  include_faces: z.boolean().default(true).describe("Include a page of face keys, perimeter vertices, local normals, texture references, and selection flags."),
  include_uv: z.boolean().default(false).describe("Include per-vertex UV coordinates for returned faces, in Blockbench texture units."),
  vertex_offset: z.number().int().nonnegative().default(0).describe("Zero-based offset into lexicographically sorted vertex keys."),
  face_offset: z.number().int().nonnegative().default(0).describe("Zero-based offset into lexicographically sorted face keys."),
  limit: z.number().int().min(1).max(500).default(100).describe("Maximum items in each included page. Continue using that page's next_offset; avoid editing geometry between pages."),
});

type Vector3 = [number, number, number];
type Bounds = { min: Vector3; max: Vector3 };
type Page<T> = { total: number; offset: number; limit: number; next_offset: number | null; truncated: boolean; items: T[] };
type TextureReference = {
  reference: string | false | null;
  status: "resolved" | "missing" | "unassigned" | "disabled" | "unset";
  uuid?: string;
  name?: string;
};
type VertexInfo = { key: string; position: Vector3; selected: boolean };
type FaceInfo = {
  key: string;
  vertices: string[];
  normal: Vector3;
  selected: boolean;
  texture: TextureReference;
  uv?: Record<string, [number, number]>;
};

/**
 * JSON-safe snapshot returned as both MCP structuredContent and JSON text.
 * Geometry, bounds, and normalized face normals use mesh-local coordinates;
 * origin/rotation describe the mesh transform and are not baked into vertices.
 * Root meshes have a null parent. Empty geometry has null local bounds.
 * Selection counts cover existing geometry, while included pages carry item flags.
 * Texture references describe stored assignments: false is unassigned, null is
 * disabled, undefined is normalized to null with status unset, and unresolved
 * strings retain their reference with status missing. They do not resolve
 * format-specific default materials or invoke other plugins' texture hooks.
 */
export type MeshInspectionResult = {
  uuid: string;
  name: string;
  origin: Vector3;
  rotation: Vector3;
  parent: { uuid: string; name: string } | null;
  totals: { vertices: number; faces: number };
  bounds: { local: Bounds | null };
  selection: { object: boolean; vertices: number; faces: number; edges: number };
  vertices?: Page<VertexInfo>;
  faces?: Page<FaceInfo>;
};

/** Static documentation metadata; importing it never accesses Blockbench globals. */
export const meshInspectionToolDocs: ToolSpec[] = [{
  name: "get_mesh_info",
  description: "Inspects a mesh by UUID/name or the first selected mesh without changing geometry, selection, or undo history. Returns transforms, parent, total counts, mesh-local bounds, selection counts, and optional paginated vertices/faces with actual runtime keys. Faces use perimeter vertex order and normalized mesh-local normals (zero for degenerate faces), stored texture references, and optional UVs. Texture status distinguishes resolved, missing, unassigned (false), disabled (null), and unset; default format materials are not resolved. Pages sort keys lexicographically and expose next_offset; geometry must remain unchanged between calls. Set include_vertices/include_faces false for a compact summary.",
  annotations: {
    title: "Get Mesh Info",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  parameters: getMeshInfoParameters,
  status: "stable",
}];

function copyVector(vector: readonly number[]): Vector3 {
  return [vector[0], vector[1], vector[2]];
}

function getLocalBounds(vertices: Record<string, ArrayVector3>): Bounds | null {
  return Object.values(vertices).reduce<Bounds | null>((bounds, vertex) => {
    if (!bounds) return { min: copyVector(vertex), max: copyVector(vertex) };
    return {
      min: [Math.min(bounds.min[0], vertex[0]), Math.min(bounds.min[1], vertex[1]), Math.min(bounds.min[2], vertex[2])],
      max: [Math.max(bounds.max[0], vertex[0]), Math.max(bounds.max[1], vertex[1]), Math.max(bounds.max[2], vertex[2])],
    };
  }, null);
}

function pageItems<T>(keys: string[], offset: number, limit: number, read: (key: string) => T): Page<T> {
  const items = keys.slice(offset, offset + limit).map(read);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < keys.length;
  return { total: keys.length, offset, limit, next_offset: hasMore ? nextOffset : null, truncated: hasMore, items };
}

function getTextureReference(reference: string | false | null | undefined): TextureReference {
  if (reference === false) return { reference, status: "unassigned" };
  if (reference === null) return { reference, status: "disabled" };
  if (reference === undefined) return { reference: null, status: "unset" };
  const texture = Project?.textures.find((candidate) => candidate.uuid === reference);
  if (!texture) return { reference, status: "missing" };
  return { reference, status: "resolved", uuid: texture.uuid, name: texture.name };
}

function getNormal(mesh: Mesh, face: MeshFace, keys: string[]): Vector3 {
  if (typeof face.getNormal === "function") return copyVector(face.getNormal(true));
  if (keys.length < 3) return [0, 0, 0];
  const [base, first, second] = keys.slice(0, 3).map((key) => mesh.vertices[key]);
  if (!base || !first || !second) return [0, 0, 0];
  const a: Vector3 = [first[0] - base[0], first[1] - base[1], first[2] - base[2]];
  const b: Vector3 = [second[0] - base[0], second[1] - base[1], second[2] - base[2]];
  const normal: Vector3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = Math.hypot(...normal);
  if (length === 0) return [0, 0, 0];
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

function getFaceInfo(mesh: Mesh, key: string, selected: Set<string>, includeUV: boolean): FaceInfo {
  const face = mesh.faces[key];
  const vertices = [...(typeof face.getSortedVertices === "function" ? face.getSortedVertices() : face.vertices)];
  const info: FaceInfo = {
    key,
    vertices,
    normal: getNormal(mesh, face, vertices),
    selected: selected.has(key),
    texture: getTextureReference(face.texture),
  };
  if (!includeUV) return info;
  return { ...info, uv: Object.fromEntries(Object.entries(face.uv ?? {}).map(([vertex, uv]) => [vertex, [uv[0], uv[1]]])) };
}

function countSelectedEdges(edges: unknown[], vertices: Set<string>): number {
  const keys = edges.flatMap((edge) => {
    if (!Array.isArray(edge) || edge.length !== 2 || !edge.every((key): key is string => typeof key === "string" && vertices.has(key)) || edge[0] === edge[1]) return [];
    return [JSON.stringify(edge.toSorted())];
  });
  return new Set(keys).size;
}

function inspectMesh(args: z.infer<typeof getMeshInfoParameters>): MeshInspectionResult {
  if (typeof Project === "undefined" || !Project) throw new Error("No project is open. Open a project before inspecting a mesh.");
  const mesh = getMeshOrSelected(args.mesh_id);
  const vertexKeys = Object.keys(mesh.vertices).toSorted();
  const faceKeys = Object.keys(mesh.faces).toSorted();
  const selection = Project.mesh_selection[mesh.uuid];
  const selectedVertices = new Set(selection?.vertices ?? []);
  const selectedFaces = new Set(selection?.faces ?? []);
  const parent = mesh.parent;
  const info: MeshInspectionResult = {
    uuid: mesh.uuid,
    name: mesh.name,
    origin: copyVector(mesh.origin),
    rotation: copyVector(mesh.rotation),
    parent: typeof parent === "object" && parent ? { uuid: parent.uuid, name: parent.name } : null,
    totals: { vertices: vertexKeys.length, faces: faceKeys.length },
    bounds: { local: getLocalBounds(mesh.vertices) },
    selection: {
      object: Mesh.selected.includes(mesh),
      vertices: vertexKeys.filter((key) => selectedVertices.has(key)).length,
      faces: faceKeys.filter((key) => selectedFaces.has(key)).length,
      edges: countSelectedEdges(selection?.edges ?? [], new Set(vertexKeys)),
    },
  };
  if (args.include_vertices) info.vertices = pageItems(vertexKeys, args.vertex_offset, args.limit, (key) => ({ key, position: copyVector(mesh.vertices[key]), selected: selectedVertices.has(key) }));
  if (args.include_faces) info.faces = pageItems(faceKeys, args.face_offset, args.limit, (key) => getFaceInfo(mesh, key, selectedFaces, args.include_uv));
  return info;
}

/** Register read-only mesh inspection with JSON text and structured MCP output. */
export function registerMeshInspectionTools(): void {
  const spec = meshInspectionToolDocs[0];
  createTool(spec.name, {
    ...spec,
    parameters: getMeshInfoParameters,
    async execute(args) {
      const result = inspectMesh(args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  }, spec.status);
}
