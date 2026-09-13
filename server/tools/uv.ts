/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import type * as Three from "three";
import { createTool, type IToolSpec } from "@/lib/factories";
import { findMeshOrThrow, getMeshOrSelected } from "@/lib/util";
import { GEOMETRY_EPSILON, STATUS_EXPERIMENTAL } from "@/lib/constants";
import { editMesh, resolveMeshFaces } from "@/lib/mesh-editing";
import {
  meshIdSchema,
  meshIdOptionalSchema,
  vector2Schema,
  uvMappingModeEnum,
  uvRotationAngleEnum,
  faceKeysOptionalSchema,
} from "@/lib/zodObjects";

declare const THREE: typeof Three;

// ============================================================================
// UV Tool Parameter Schemas
// ============================================================================

/** Parameters for setting mesh UV */
export const setMeshUvParametersSchema = z.object({
  mesh_id: meshIdSchema,
  face_key: z.string().describe("Face key to set UV for."),
  uv_mapping: z
    .record(
      z.string(), // vertex key
      vector2Schema // UV coordinates
    )
    .describe("UV coordinates for each vertex of the face."),
});

/**
 * Parameters for `auto_uv_mesh`: an optional target mesh (defaults to the
 * selected mesh), the automatic mapping `mode`, and optional face keys
 * (defaults to the mesh's selected faces).
 */
export const autoUvMeshParametersSchema = z.object({
  mesh_id: meshIdOptionalSchema,
  mode: uvMappingModeEnum
    .default("project")
    .describe(
      "project uses the active preview; unwrap is per-face planar projection; cylinder and sphere use the local origin."
    ),
  faces: faceKeysOptionalSchema.describe(
    "Specific face keys to UV map. If not provided, maps all selected faces."
  ),
});

/** Parameters for rotating mesh UV */
export const rotateMeshUvParametersSchema = z.object({
  mesh_id: meshIdOptionalSchema,
  angle: uvRotationAngleEnum.default("90").describe("Rotation angle in degrees."),
  faces: faceKeysOptionalSchema.describe(
    "Specific face keys to rotate UV for. If not provided, rotates all selected faces."
  ),
});

// ============================================================================
// UV Tool Docs
// ============================================================================

/**
 * Specs for the mesh UV tools, shared by `registerUVTools` and the docs
 * manifest. Registration reads entries by index, in this order:
 * `set_mesh_uv`, `auto_uv_mesh`, `rotate_mesh_uv`.
 * Built without Blockbench globals so the doc generator can import it outside the host.
 */
export const uvToolDocs: IToolSpec[] = [
  {
    name: "set_mesh_uv",
    description: "Sets UV coordinates for mesh faces or vertices.",
    annotations: {
      title: "Set Mesh UV",
      destructiveHint: true,
    },
    parameters: setMeshUvParametersSchema,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "auto_uv_mesh",
    description: "Maps only the specified/selected faces of the target mesh. project uses the active camera, unwrap projects each face to its own plane, and cylinder/sphere map around the local origin. This does not pack UV islands.",
    annotations: {
      title: "Auto UV Mesh",
      destructiveHint: true,
    },
    parameters: autoUvMeshParametersSchema,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "rotate_mesh_uv",
    description: "Rotates only the target mesh's specified/selected faces around their combined UV bounding-box center, without clamping or changing selection.",
    annotations: {
      title: "Rotate Mesh UV",
      destructiveHint: true,
    },
    parameters: rotateMeshUvParametersSchema,
    status: STATUS_EXPERIMENTAL,
  },
];

// ============================================================================
// UV Mapping Math
// ============================================================================

/** A UV coordinate `[u, v]` in texture pixels. */
type UV = [number, number];
/** Index of a UV axis: 0 for U, 1 for V. */
type UvAxis = 0 | 1;
/** Face key -> vertex key -> UV; the shape written back to mesh faces. */
type Mapping = Record<string, Record<string, UV>>;
/** Automatic mapping mode accepted by `auto_uv_mesh`. */
type UvMappingMode = z.infer<typeof uvMappingModeEnum>;
/** Computes UVs for the `keys` faces of `mesh`; throws before any mesh edit starts. */
type AutoMapper = (mesh: Mesh, keys: string[], project: ModelProject) => Mapping;

/** Preview whose runtime `calculateControlScale` method is verified by `isProjectionPreview`. */
interface IProjectionPreview extends Preview {
  calculateControlScale: (point: Three.Vector3) => number;
}

/**
 * Divisor applied to `Preview#calculateControlScale`, matching Blockbench's
 * native "Project from View" action so projected UVs have the same scale.
 */
const PROJECT_FROM_VIEW_SCALE_DIVISOR = 14;

/**
 * Model units covered by the cylinder mapping's V axis: one 16-unit block
 * centered on the local origin, so y in [-8, 8] maps to the full texture height.
 */
const CYLINDER_SPAN_UNITS = 16;

/** Per-mode automatic mappers, looked up by `auto_uv_mesh`'s `mode`. */
const AUTO_MAPPERS: Record<UvMappingMode, AutoMapper> = {
  project: (mesh, keys) => projectFromView(mesh, keys),
  unwrap: (mesh, keys) =>
    Object.fromEntries(keys.map((key): [string, Record<string, UV>] => [key, unwrapFace(mesh, key)])),
  cylinder: (mesh, keys, project) =>
    mapSortedVertices(mesh, keys, vertex => cylinderUv(mesh.vertices[vertex], project)),
  sphere: (mesh, keys, project) =>
    mapSortedVertices(mesh, keys, vertex => sphereUv(vertex, mesh.vertices[vertex], project)),
};

/** Evaluates `valueAt` for the U then V axis. */
function perAxis(valueAt: (axis: UvAxis) => number): UV {
  return [valueAt(0), valueAt(1)];
}

/** Midpoint of the min/max extent of `coordinates` along one axis. */
function axisCenter(coordinates: UV[], axis: UvAxis): number {
  const values = coordinates.map(uv => uv[axis]);
  return (Math.min(...values) + Math.max(...values)) / 2;
}

/** Current UV of a face vertex, defaulting to the origin when unset. */
function currentUv(face: MeshFace, vertex: string): UV {
  return face.uv[vertex] ?? [0, 0];
}

/** Builds a mapping that assigns every sorted vertex of each face the UV from `uvFor`. */
function mapSortedVertices(mesh: Mesh, keys: string[], uvFor: (vertex: string) => UV): Mapping {
  return Object.fromEntries(keys.map((key): [string, Record<string, UV>] => [
    key,
    Object.fromEntries(mesh.faces[key].getSortedVertices().map((vertex): [string, UV] => [vertex, uvFor(vertex)])),
  ]));
}

/** blockbench-types omits `Preview#calculateControlScale`; this guard verifies it and the camera/canvas at runtime. */
function isProjectionPreview(preview: Preview | undefined): preview is IProjectionPreview {
  if (!preview?.camera || !preview.canvas) return false;
  return "calculateControlScale" in preview && typeof preview.calculateControlScale === "function";
}

/** Projects vertices through the active camera, then recenters them on the faces' previous UV mean. */
function projectFromView(mesh: Mesh, keys: string[]): Mapping {
  const preview = Preview.selected;
  if (!isProjectionPreview(preview)) {
    throw new Error("Project UV requires an active 3D preview. Focus a preview or use mode 'unwrap'.");
  }
  const vertices = [...new Set(keys.flatMap(key => mesh.faces[key].vertices))];
  const scale = preview.calculateControlScale(mesh.getWorldCenter()) / PROJECT_FROM_VIEW_SCALE_DIVISOR;
  const width = preview.canvas.width / (window.devicePixelRatio || 1) / 2;
  const height = preview.canvas.height / (window.devicePixelRatio || 1) / 2;
  mesh.mesh.updateMatrixWorld(true);
  const raw = Object.fromEntries(vertices.map((key): [string, UV] => {
    const vector = mesh.mesh.localToWorld(new THREE.Vector3(...mesh.vertices[key])).project(preview.camera);
    return [key, [(vector.x * width + width) * scale, (-vector.y * height + height) * scale]];
  }));
  const coordinates = Object.values(raw);
  const old = keys.flatMap(key => mesh.faces[key].vertices.map(vertex => currentUv(mesh.faces[key], vertex)));
  const offset = perAxis(axis =>
    old.reduce((sum, uv) => sum + uv[axis], 0) / old.length - axisCenter(coordinates, axis)
  );
  const projected = Object.fromEntries(
    vertices.map((key): [string, UV] => [key, perAxis(axis => raw[key][axis] + offset[axis])])
  );
  return mapSortedVertices(mesh, keys, vertex => projected[vertex]);
}

/** Projects one face onto its own plane, keeping the face's previous UV mean. */
function unwrapFace(mesh: Mesh, key: string): Record<string, UV> {
  const face = mesh.faces[key];
  const vertices = face.getSortedVertices();
  const normal = new THREE.Vector3(...face.getNormal(true));
  const origin = new THREE.Vector3(...mesh.vertices[vertices[0]]);
  const tangent = new THREE.Vector3(...mesh.vertices[vertices[1]]).sub(origin).normalize();
  if (normal.lengthSq() < GEOMETRY_EPSILON || tangent.lengthSq() < GEOMETRY_EPSILON) {
    throw new Error(`Face "${key}" is degenerate and cannot be unwrapped.`);
  }
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
  const planar = vertices.map((vertex): UV => {
    const point = new THREE.Vector3(...mesh.vertices[vertex]).sub(origin);
    return [point.dot(tangent), point.dot(bitangent)];
  });
  const offset = perAxis(axis =>
    vertices.reduce((sum, vertex, index) => sum + (face.uv[vertex]?.[axis] ?? 0) - planar[index][axis], 0) / vertices.length
  );
  return Object.fromEntries(
    vertices.map((vertex, index): [string, UV] => [vertex, perAxis(axis => planar[index][axis] + offset[axis])])
  );
}

/** Angle around the local Y axis scaled to texture width; the U axis shared by cylinder and sphere mapping. */
function azimuthU(point: ArrayVector3, project: ModelProject): number {
  return (Math.atan2(point[0], point[2]) + Math.PI) / (2 * Math.PI) * project.texture_width;
}

/** Cylindrical UV: azimuth for U, height within the centered one-block span for V. */
function cylinderUv(point: ArrayVector3, project: ModelProject): UV {
  const height = (point[1] + CYLINDER_SPAN_UNITS / 2) / CYLINDER_SPAN_UNITS;
  return [azimuthU(point, project), height * project.texture_height];
}

/** Spherical UV: azimuth for U, polar angle from +Y for V; rejects vertices at the local origin. */
function sphereUv(vertex: string, point: ArrayVector3, project: ModelProject): UV {
  const length = Math.hypot(...point);
  if (length < GEOMETRY_EPSILON) {
    throw new Error(`Cannot sphere-map vertex "${vertex}" at the local origin. Move it or use unwrap.`);
  }
  const polar = Math.acos(Math.max(-1, Math.min(1, point[1] / length)));
  return [azimuthU(point, project), polar / Math.PI * project.texture_height];
}

/** Rotates `uv` counter-clockwise by `radians` around `center`. */
function rotateAround(uv: UV, center: UV, radians: number): UV {
  const x = uv[0] - center[0];
  const y = uv[1] - center[1];
  return [
    x * Math.cos(radians) - y * Math.sin(radians) + center[0],
    x * Math.sin(radians) + y * Math.cos(radians) + center[1],
  ];
}

/** Validates every coordinate is finite, then writes the mapping in one UV-only mesh edit. */
function applyMapping(mesh: Mesh, label: string, mapping: Mapping): void {
  if (Object.values(mapping).some(uvs => Object.values(uvs).some(uv => !uv.every(Number.isFinite)))) {
    throw new Error("UV mapping produced non-finite coordinates; check mesh geometry and the active camera.");
  }
  editMesh(mesh, label, () => {
    Object.entries(mapping).forEach(([face, uvs]) => {
      // Faces must own independent tuples: native Undo restores UV arrays in
      // place, so sharing a projected vertex's tuple corrupts adjacent seams.
      Object.entries(uvs).forEach(([vertex, uv]) => { mesh.faces[face].uv[vertex] = [uv[0], uv[1]]; });
    });
    UVEditor.loadData();
  }, true);
}

/** Computes an automatic mapping for `keys` faces; requires an open project for texture dimensions. */
function automaticMapping(mesh: Mesh, keys: string[], mode: UvMappingMode): Mapping {
  const project = Project;
  if (!project) throw new Error("No project is open.");
  return AUTO_MAPPERS[mode](mesh, keys, project);
}

// ============================================================================
// UV Tool Implementations
// ============================================================================

/** Writes explicit UVs for vertices of one existing face. */
async function setMeshUv({ mesh_id, face_key, uv_mapping }: z.infer<typeof setMeshUvParametersSchema>): Promise<string> {
  const mesh = findMeshOrThrow(mesh_id);
  resolveMeshFaces(mesh, [face_key]);
  const face = mesh.faces[face_key];
  if (!Object.keys(uv_mapping).length || Object.keys(uv_mapping).some(key => !face.vertices.includes(key))) {
    throw new Error("uv_mapping must contain existing vertex keys from the requested face.");
  }
  const uvs = Object.fromEntries(Object.entries(uv_mapping).map(([key, uv]): [string, UV] => [key, [uv[0], uv[1]]]));
  applyMapping(mesh, "Set mesh UV", { [face_key]: uvs });
  return `Set UV mapping for face "${face_key}" of mesh "${mesh.name}"`;
}

/** Applies an automatic mapping mode to the requested or selected faces. */
async function autoUvMesh({ mesh_id, mode, faces }: z.infer<typeof autoUvMeshParametersSchema>): Promise<string> {
  const mesh = getMeshOrSelected(mesh_id);
  const selectedFaces = resolveMeshFaces(mesh, faces);
  applyMapping(mesh, "Auto UV mesh", automaticMapping(mesh, selectedFaces, mode));
  return `Applied ${mode} UV mapping to ${selectedFaces.length} faces of mesh "${mesh.name}"`;
}

/** Rotates the requested or selected faces' UVs around their combined bounding-box center. */
async function rotateMeshUv({ mesh_id, angle, faces }: z.infer<typeof rotateMeshUvParametersSchema>): Promise<string> {
  const mesh = getMeshOrSelected(mesh_id);
  const affected = resolveMeshFaces(mesh, faces);
  const coordinates = affected.flatMap(key => mesh.faces[key].vertices.map(vertex => currentUv(mesh.faces[key], vertex)));
  const center = perAxis(axis => axisCenter(coordinates, axis));
  const radians = Number(angle) * Math.PI / 180;
  const mapping = Object.fromEntries(affected.map((key): [string, Record<string, UV>] => {
    const face = mesh.faces[key];
    const rotated = face.vertices.map((vertex): [string, UV] => [vertex, rotateAround(currentUv(face, vertex), center, radians)]);
    return [key, Object.fromEntries(rotated)];
  }));
  applyMapping(mesh, "Rotate mesh UV", mapping);
  return `Rotated UV by ${angle} degrees for ${affected.length} faces of mesh "${mesh.name}"`;
}

/** Register UV tools whose explicit mesh/face targets never depend on other UI selections. */
export function registerUVTools(): void {
  createTool(
    uvToolDocs[0].name,
    { ...uvToolDocs[0], parameters: setMeshUvParametersSchema, execute: setMeshUv },
    uvToolDocs[0].status
  );

  createTool(
    uvToolDocs[1].name,
    { ...uvToolDocs[1], parameters: autoUvMeshParametersSchema, execute: autoUvMesh },
    uvToolDocs[1].status
  );

  createTool(
    uvToolDocs[2].name,
    { ...uvToolDocs[2], parameters: rotateMeshUvParametersSchema, execute: rotateMeshUv },
    uvToolDocs[2].status
  );
}
