/**
 * Edit operations for mesh elements in `.bbmodel` documents.
 *
 * - `add_mesh` builds a mesh from explicit vertices and faces.
 * - `add_mesh_primitive` ports Blockbench's Add Mesh dialog, Auto UV included.
 * - `edit_mesh` applies an ordered, atomic list of geometry actions (vertex and
 *   face edits, merge, extrude, subdivide, loop cut).
 * - `map_mesh_uv` re-maps face UVs (Blockbench Auto UV, axis projections, or explicit values).
 *
 * Handlers follow the pattern of `./particle-operations`: pure functions from
 * a document to a new document plus a result, throwing on bad input. They are
 * collected in {@link MESH_HANDLERS} for `operations.ts` to register. Format
 * rules (meshes are only valid in the `free` format) are left to the caller.
 *
 * Texture references are resolved locally instead of importing
 * `resolveTexture` from `./operations`: once `operations.ts` imports this
 * module, a back-import would form a cycle that breaks when this module loads
 * first (its schemas would be read before initialization).
 *
 * @module
 */

import { z } from "zod";
import { type IBBModel, type IMesh, isMesh, vec2Schema, vec3Schema } from "../document/schema";
import { indexModel, insertNode, resolveNode } from "../document/tree";
import { meshActionSchema, applyMeshActions } from "../mesh/actions";
import { autoUvFaces, projectUv } from "../mesh/auto-uv";
import { MeshDraft } from "../mesh/draft";
import { addFaces, assertFiniteGeometry } from "../mesh/editing";
import { assignMeshTexture, buildMeshElement, geometryOf, withGeometry } from "../mesh/element";
import { autoUvNewFaces, meshFaceInputSchema, meshTextureRef, resolveFaceInputs } from "../mesh/faces-input";
import { buildPrimitive, PRIMITIVE_DEFAULTS, PRIMITIVE_SHAPES } from "../mesh/primitives";
import { countsOf, EMPTY_GEOMETRY, type IMeshGeometry, type MeshFaceData, type UvSize, type Vec2 } from "../mesh/types";
import { isFiniteVec } from "../mesh/vector";
import { freshUuid } from "./refs";

const meshRef = z.string().min(1).describe("Mesh UUID or exact name.");
const parentRef = z.string().min(1).nullable().optional().describe("Parent group UUID or name; null or omitted places the mesh at the root.");
const colorIndex = z.number().int().min(0).max(9).optional().describe("Marker color 0-9; Blockbench picks one at random when omitted.");

/** Adds a mesh from explicit geometry. */
export const addMeshOp = z.object({
  op: z.literal("add_mesh"),
  name: z.string().min(1),
  origin: vec3Schema.optional().describe("Pivot and position; vertices are relative to it. Defaults to the parent group's origin (Blockbench bone rig), else [0, 0, 0]."),
  rotation: vec3Schema.optional().describe("Degrees, Euler ZYX about origin."),
  parent: parentRef,
  vertices: z
    .union([z.record(z.string().min(1), vec3Schema), z.array(vec3Schema).min(3)])
    .describe("{key: [x, y, z]} keeping your keys, or an array of [x, y, z] (4-character keys are generated). Positions are relative to origin."),
  faces: z.array(meshFaceInputSchema).min(1),
  texture: meshTextureRef.optional().describe("Texture for every face that does not name one."),
  color: colorIndex,
  uuid: z.string().uuid().optional(),
});

/** Adds a primitive exactly like Blockbench's Add Mesh dialog. */
export const addMeshPrimitiveOp = z.object({
  op: z.literal("add_mesh_primitive"),
  shape: z.enum(PRIMITIVE_SHAPES),
  name: z.string().min(1).optional().describe("Defaults to Blockbench's name: the shape id, or mesh for cuboid."),
  origin: vec3Schema.optional().describe("Defaults to the parent group's origin, else [0, 0, 0]. Shapes sit on it: round shapes and cuboids start at y = 0; sphere, torus and polyhedra are centered."),
  rotation: vec3Schema.optional(),
  parent: parentRef,
  diameter: z.number().positive().default(PRIMITIVE_DEFAULTS.diameter).describe("Default 16. For icosphere, octahedron and dodecahedron Blockbench uses this value as the radius."),
  height: z.number().default(PRIMITIVE_DEFAULTS.height).describe("cylinder, cone, cuboid, beveled_cuboid, pyramid, tube. Default 8."),
  sides: z.number().int().min(3).max(48).default(PRIMITIVE_DEFAULTS.sides).describe("cylinder, cone, circle, torus, sphere, tube. Default 12."),
  align_edges: z.boolean().default(PRIMITIVE_DEFAULTS.align_edges).describe("Round shapes: rotate half a side and widen so flat sides face the axes. Default true."),
  detail: z.number().int().min(0).max(6).default(PRIMITIVE_DEFAULTS.detail).describe("icosphere, octahedron, dodecahedron subdivision. Default 1."),
  minor_diameter: z.number().positive().default(PRIMITIVE_DEFAULTS.minor_diameter).describe("torus tube diameter or tube wall (×2). Default 4."),
  minor_sides: z.number().int().min(2).max(32).default(PRIMITIVE_DEFAULTS.minor_sides).describe("torus. Default 8."),
  edge_size: z.number().min(0).default(PRIMITIVE_DEFAULTS.edge_size).describe("beveled_cuboid bevel. Default 2."),
  texture: meshTextureRef.optional().describe("Texture for every face."),
  color: colorIndex,
  uuid: z.string().uuid().optional(),
});

/** Applies an ordered list of geometry actions to one mesh, atomically. */
export const editMeshOp = z.object({
  op: z.literal("edit_mesh"),
  target: meshRef,
  actions: z.array(meshActionSchema).min(1),
});

/** Re-maps mesh face UVs. */
export const mapMeshUvOp = z.object({
  op: z.literal("map_mesh_uv"),
  target: meshRef,
  faces: z.array(z.string().min(1)).optional().describe("Face keys; omit for all faces."),
  mode: z
    .enum(["auto", "project_x", "project_y", "project_z", "explicit"])
    .describe("auto: Blockbench Auto UV per face. project_*: one orthographic projection along the axis for all listed faces (x from +X, y from above, z from +Z), placed at [0, 0]. explicit: uv values as given."),
  uv: z.record(z.string(), z.record(z.string(), vec2Schema)).optional().describe("explicit mode: face key → vertex key → [u, v]."),
  scale: z.number().positive().optional().describe("project_* modes: UV units per model unit (default 1)."),
  texture: meshTextureRef.nullable().optional().describe("Also assign this texture to the faces (null disables them); auto mode then fits the texture's UV size."),
});

/** Every mesh operation schema, for registration in the operation union. */
export const MESH_OPERATION_SCHEMAS = [addMeshOp, addMeshPrimitiveOp, editMeshOp, mapMeshUvOp] as const;

/** What a mesh operation did. */
export interface IMeshOpResult {
  op: "add_mesh" | "add_mesh_primitive" | "edit_mesh" | "map_mesh_uv";
  uuid?: string;
  name?: string;
  detail?: string;
}

/** Resolves a texture reference to its index (same rules as `resolveTexture` in operations.ts). */
function textureIndex(doc: IBBModel, ref: string | number): number {
  if (typeof ref === "number") {
    if (ref < doc.textures.length) return ref;
    throw new Error(`Texture index ${ref} is out of range (${doc.textures.length} textures).`);
  }
  const index = doc.textures.findIndex((texture) => texture.uuid === ref || texture.name === ref);
  if (index >= 0) return index;
  throw new Error(`No texture named or identified "${ref}".`);
}

/** UV space of a face: its texture's uv size in per-texture-UV formats (free), else the project resolution. */
const uvSizeFor = (doc: IBBModel) => (face: MeshFaceData): UvSize => {
  const texture = typeof face.texture === "number" ? doc.textures[face.texture] : undefined;
  return [texture?.uv_width ?? doc.resolution.width, texture?.uv_height ?? doc.resolution.height];
};

/** Parent group and default origin (Blockbench `bone_rig` formats inherit the parent's origin). */
function placement(doc: IBBModel, parentRefValue: string | null | undefined): { parent: string | null; origin: [number, number, number] } {
  if (!parentRefValue) return { parent: null, origin: [0, 0, 0] };
  const index = indexModel(doc);
  const parent = resolveNode(index, parentRefValue, ["group"]).uuid;
  const origin = index.groups.get(parent)?.origin ?? [0, 0, 0];
  return { parent, origin: [origin[0], origin[1], origin[2]] };
}

/** Finds a mesh element by UUID or name. */
function findMesh(doc: IBBModel, ref: string): IMesh {
  const { uuid } = resolveNode(indexModel(doc), ref, ["element"]);
  const element = doc.elements.find((entry) => entry.uuid === uuid);
  if (!element || !isMesh(element)) throw new Error(`${ref} is a ${element?.type ?? "missing element"}, not a mesh.`);
  return element;
}

const replaceElement = (doc: IBBModel, mesh: IMesh): IBBModel => ({ ...doc, elements: doc.elements.map((element) => (element.uuid === mesh.uuid ? mesh : element)) });

const describeCounts = (before: IMeshGeometry, after: IMeshGeometry): string => {
  const a = countsOf(before);
  const b = countsOf(after);
  return `vertices ${a.vertices} -> ${b.vertices}, faces ${a.faces} -> ${b.faces}`;
};

/** Inserts a new mesh element into the document. */
function insertMesh(doc: IBBModel, mesh: IMesh, parent: string | null): IBBModel {
  return { ...doc, elements: [...doc.elements, mesh], outliner: insertNode(doc.outliner, parent, mesh.uuid) };
}

/**
 * Adds a mesh from explicit vertices and faces.
 *
 * @throws Error for unknown vertex references, faces without 3-4 distinct vertices, non-finite positions, or bad textures.
 */
export function applyAddMesh(doc: IBBModel, op: z.infer<typeof addMeshOp>): [IBBModel, IMeshOpResult] {
  const { parent, origin } = placement(doc, op.parent);
  const uuid = freshUuid(doc, op.uuid);
  const inputVertices = Array.isArray(op.vertices) ? op.vertices : Object.values(op.vertices);
  if (!inputVertices.every(isFiniteVec)) throw new Error("Every vertex coordinate must be a finite number.");
  const withVertices = (() => {
    if (!Array.isArray(op.vertices)) return { geometry: { vertices: { ...op.vertices }, faces: {} }, order: Object.keys(op.vertices) };
    const draft = MeshDraft.from(EMPTY_GEOMETRY);
    const order = draft.addVertices(...op.vertices);
    return { geometry: draft.toGeometry(), order };
  })();
  const fallback = op.texture === undefined ? undefined : textureIndex(doc, op.texture);
  const { faces, needsUv } = resolveFaceInputs(op.faces, withVertices.order, (ref) => textureIndex(doc, ref), fallback);
  const added = addFaces(withVertices.geometry, faces);
  const geometry = autoUvNewFaces(added.geometry, added.keys.filter((_, index) => needsUv[index]), uvSizeFor(doc));
  const mesh = buildMeshElement({ name: op.name, uuid, origin: op.origin ?? origin, rotation: op.rotation ?? [0, 0, 0], geometry, ...(op.color === undefined ? {} : { color: op.color }) });
  const counts = countsOf(geometry);
  return [insertMesh(doc, mesh, parent), { op: op.op, uuid, name: op.name, detail: `${counts.vertices} vertices, ${counts.faces} faces` }];
}

/**
 * Adds a primitive built like Blockbench's Add Mesh dialog, Auto UV included.
 *
 * @throws Error for a bad parent or texture.
 */
export function applyAddMeshPrimitive(doc: IBBModel, op: z.infer<typeof addMeshPrimitiveOp>): [IBBModel, IMeshOpResult] {
  const { parent, origin } = placement(doc, op.parent);
  const uuid = freshUuid(doc, op.uuid);
  const built = buildPrimitive(op, [doc.resolution.width, doc.resolution.height]);
  const texture = op.texture === undefined ? undefined : textureIndex(doc, op.texture);
  const name = op.name ?? built.name;
  const mesh = buildMeshElement({ name, uuid, origin: op.origin ?? origin, rotation: op.rotation ?? [0, 0, 0], geometry: built.geometry, ...(op.color === undefined ? {} : { color: op.color }) });
  const textured = texture === undefined ? mesh : assignMeshTexture(mesh, texture);
  const counts = countsOf(built.geometry);
  return [insertMesh(doc, textured, parent), { op: op.op, uuid, name, detail: `${op.shape}: ${counts.vertices} vertices, ${counts.faces} faces` }];
}

/**
 * Applies geometry actions to a mesh in order; any failure rejects the whole operation.
 *
 * @throws Error when the target is not a mesh or an action fails.
 */
export function applyEditMesh(doc: IBBModel, op: z.infer<typeof editMeshOp>): [IBBModel, IMeshOpResult] {
  const mesh = findMesh(doc, op.target);
  const before = geometryOf(mesh);
  const after = applyMeshActions(before, op.actions, { resolveTexture: (ref) => textureIndex(doc, ref), uvSizeOf: uvSizeFor(doc) });
  assertFiniteGeometry(after);
  if (Object.keys(after.faces).length === 0) throw new Error("The edits would leave the mesh without faces; remove the element instead.");
  return [replaceElement(doc, withGeometry(mesh, after)), { op: op.op, uuid: mesh.uuid, name: mesh.name, detail: describeCounts(before, after) }];
}

/** Applies explicit UVs; every listed face must receive a UV for each of its vertices. */
function explicitUv(geometry: IMeshGeometry, uv: Readonly<Record<string, Readonly<Record<string, Vec2>>>>): IMeshGeometry {
  const faces = Object.fromEntries(Object.entries(geometry.faces).map(([key, face]) => {
    const values = uv[key];
    if (!values) return [key, face];
    const missing = face.vertices.filter((vertex) => values[vertex] === undefined);
    if (missing.length) throw new Error(`uv for face ${key} lacks vertex ${missing.join(", ")}.`);
    const extra = Object.keys(values).filter((vertex) => !face.vertices.includes(vertex));
    if (extra.length) throw new Error(`uv for face ${key} names vertex ${extra.join(", ")}, which is not on that face.`);
    return [key, { ...face, uv: Object.fromEntries(face.vertices.map((vertex) => [vertex, values[vertex] as Vec2])) }];
  }));
  return { ...geometry, faces };
}

/**
 * Re-maps UVs of a mesh's faces, optionally assigning a texture first.
 *
 * @throws Error for unknown faces, a missing `uv` in explicit mode, or `scale` outside projection modes.
 */
export function applyMapMeshUv(doc: IBBModel, op: z.infer<typeof mapMeshUvOp>): [IBBModel, IMeshOpResult] {
  const mesh = findMesh(doc, op.target);
  const keys = op.faces ?? Object.keys(mesh.faces);
  const missing = keys.filter((key) => mesh.faces[key] === undefined);
  if (missing.length) throw new Error(`Mesh ${mesh.name} has no face(s) ${missing.join(", ")}.`);
  if (op.scale !== undefined && !op.mode.startsWith("project_")) throw new Error("scale applies to project_x, project_y and project_z only.");
  if (op.mode === "explicit" && op.uv === undefined) throw new Error("explicit mode needs uv.");
  const textured = op.texture === undefined ? mesh : assignMeshTexture(mesh, op.texture === null ? null : textureIndex(doc, op.texture), keys);
  const geometry = geometryOf(textured);
  const listed = new Set(keys);
  const mapped = (() => {
    if (op.mode === "auto") return autoUvFaces(geometry, keys, uvSizeFor(doc));
    if (op.mode === "explicit") {
      const outside = Object.keys(op.uv ?? {}).filter((key) => !listed.has(key));
      if (outside.length) throw new Error(`uv names face(s) ${outside.join(", ")} outside the selected faces.`);
      return explicitUv(geometry, op.uv ?? {});
    }
    const axis = ({ project_x: "x", project_y: "y", project_z: "z" } as const)[op.mode];
    return projectUv(geometry, keys, axis, op.scale ?? 1);
  })();
  return [replaceElement(doc, withGeometry(textured, mapped)), { op: op.op, uuid: mesh.uuid, name: mesh.name, detail: `${op.mode} on ${keys.length} face(s)` }];
}

type MeshOperation = z.infer<(typeof MESH_OPERATION_SCHEMAS)[number]>;

type MeshHandler<K extends MeshOperation["op"]> = (doc: IBBModel, op: Extract<MeshOperation, { op: K }>) => [IBBModel, IMeshOpResult];

/** Mesh operation handlers keyed by op name, for `operations.ts` to merge into its handler table. */
export const MESH_HANDLERS: { [K in MeshOperation["op"]]: MeshHandler<K> } = {
  add_mesh: applyAddMesh,
  add_mesh_primitive: applyAddMeshPrimitive,
  edit_mesh: applyEditMesh,
  map_mesh_uv: applyMapMeshUv,
};

export { assignMeshTexture };
