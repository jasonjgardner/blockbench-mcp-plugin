/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import type * as Three from "three";
import { createTool, type ToolSpec } from "@/lib/factories";
import { findMeshOrThrow, getMeshOrSelected } from "@/lib/util";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";
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

/** Parameters for auto UV mesh */
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

export const uvToolDocs: ToolSpec[] = [
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

type UV = [number, number];
type Mapping = Record<string, Record<string, UV>>;

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

function automaticMapping(mesh: Mesh, keys: string[], mode: "project" | "unwrap" | "cylinder" | "sphere"): Mapping {
  const project = Project;
  if (!project) throw new Error("No project is open.");
  const projected: Record<string, UV> = {};
  if (mode === "project") {
    const preview = Preview.selected as Preview & { calculateControlScale?: (point: Three.Vector3) => number };
    if (!preview?.camera || !preview.canvas || typeof preview.calculateControlScale !== "function") {
      throw new Error("Project UV requires an active 3D preview. Focus a preview or use mode 'unwrap'.");
    }
    const vertices = [...new Set(keys.flatMap(key => mesh.faces[key].vertices))];
    const scale = preview.calculateControlScale(mesh.getWorldCenter()) / 14;
    const width = preview.canvas.width / (window.devicePixelRatio || 1) / 2;
    const height = preview.canvas.height / (window.devicePixelRatio || 1) / 2;
    mesh.mesh.updateMatrixWorld(true);
    vertices.forEach(key => {
      const vector = mesh.mesh.localToWorld(new THREE.Vector3(...mesh.vertices[key])).project(preview.camera);
      projected[key] = [(vector.x * width + width) * scale, (-vector.y * height + height) * scale];
    });
    const coordinates = Object.values(projected);
    const old = keys.flatMap(key => mesh.faces[key].vertices.map(vertex => mesh.faces[key].uv[vertex] ?? [0, 0]));
    const offset = [0, 1].map(axis => old.reduce((sum, uv) => sum + uv[axis], 0) / old.length - (Math.min(...coordinates.map(uv => uv[axis])) + Math.max(...coordinates.map(uv => uv[axis]))) / 2);
    vertices.forEach(key => { projected[key] = [projected[key][0] + offset[0], projected[key][1] + offset[1]]; });
  }
  return Object.fromEntries(keys.map(key => {
    const face = mesh.faces[key];
    const vertices = face.getSortedVertices();
    if (mode === "project") return [key, Object.fromEntries(vertices.map(vertex => [vertex, projected[vertex]]))];
    if (mode === "unwrap") {
      const normal = new THREE.Vector3(...face.getNormal(true));
      const origin = new THREE.Vector3(...mesh.vertices[vertices[0]]);
      const tangent = new THREE.Vector3(...mesh.vertices[vertices[1]]).sub(origin).normalize();
      if (normal.lengthSq() < 1e-8 || tangent.lengthSq() < 1e-8) throw new Error(`Face "${key}" is degenerate and cannot be unwrapped.`);
      const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
      const uvs = vertices.map(vertex => {
        const point = new THREE.Vector3(...mesh.vertices[vertex]).sub(origin);
        return [point.dot(tangent), point.dot(bitangent)] as UV;
      });
      const offset = [0, 1].map(axis => vertices.reduce((sum, vertex, index) => sum + (face.uv[vertex]?.[axis] ?? 0) - uvs[index][axis], 0) / vertices.length);
      return [key, Object.fromEntries(vertices.map((vertex, index) => [vertex, [uvs[index][0] + offset[0], uvs[index][1] + offset[1]]]))];
    }
    return [key, Object.fromEntries(vertices.map(vertex => {
      const point = mesh.vertices[vertex];
      const u = (Math.atan2(point[0], point[2]) + Math.PI) / (2 * Math.PI) * project.texture_width;
      if (mode === "cylinder") return [vertex, [u, (point[1] + 8) / 16 * project.texture_height]];
      const length = Math.hypot(...point);
      if (length < 1e-8) throw new Error(`Cannot sphere-map vertex "${vertex}" at the local origin. Move it or use unwrap.`);
      return [vertex, [u, Math.acos(Math.max(-1, Math.min(1, point[1] / length))) / Math.PI * project.texture_height]];
    }))];
  })) as Mapping;
}

/** Register UV tools whose explicit mesh/face targets never depend on other UI selections. */
export function registerUVTools(): void {
  createTool(
    uvToolDocs[0].name,
    {
      ...uvToolDocs[0],
      parameters: setMeshUvParametersSchema,
      async execute({ mesh_id, face_key, uv_mapping }) {
        const mesh = findMeshOrThrow(mesh_id);
        resolveMeshFaces(mesh, [face_key]);
        const face = mesh.faces[face_key];
        if (!Object.keys(uv_mapping).length || Object.keys(uv_mapping).some(key => !face.vertices.includes(key))) {
          throw new Error("uv_mapping must contain existing vertex keys from the requested face.");
        }
        applyMapping(mesh, "Set mesh UV", { [face_key]: Object.fromEntries(Object.entries(uv_mapping).map(([key, uv]) => [key, [uv[0], uv[1]] as UV])) });
        return `Set UV mapping for face "${face_key}" of mesh "${mesh.name}"`;
      },
    },
    uvToolDocs[0].status
  );

  createTool(
    uvToolDocs[1].name,
    {
      ...uvToolDocs[1],
      parameters: autoUvMeshParametersSchema,
      async execute({ mesh_id, mode, faces }) {
        const mesh = getMeshOrSelected(mesh_id);
        const selectedFaces = resolveMeshFaces(mesh, faces);
        applyMapping(mesh, "Auto UV mesh", automaticMapping(mesh, selectedFaces, mode));
        return `Applied ${mode} UV mapping to ${selectedFaces.length} faces of mesh "${mesh.name}"`;
      },
    },
    uvToolDocs[1].status
  );

  createTool(
    uvToolDocs[2].name,
    {
      ...uvToolDocs[2],
      parameters: rotateMeshUvParametersSchema,
      async execute({ mesh_id, angle, faces }) {
        const mesh = getMeshOrSelected(mesh_id);
        const affected = resolveMeshFaces(mesh, faces);
        const coordinates = affected.flatMap(key => mesh.faces[key].vertices.map(vertex => mesh.faces[key].uv[vertex] ?? [0, 0]));
        const center = [0, 1].map(axis => (Math.min(...coordinates.map(uv => uv[axis])) + Math.max(...coordinates.map(uv => uv[axis]))) / 2);
        const radians = Number(angle) * Math.PI / 180;
        const mapping = Object.fromEntries(affected.map(key => [key, Object.fromEntries(mesh.faces[key].vertices.map(vertex => {
          const uv = mesh.faces[key].uv[vertex] ?? [0, 0];
          const x = uv[0] - center[0];
          const y = uv[1] - center[1];
          return [vertex, [x * Math.cos(radians) - y * Math.sin(radians) + center[0], x * Math.sin(radians) + y * Math.cos(radians) + center[1]] as UV];
        }))]));
        applyMapping(mesh, "Rotate mesh UV", mapping);
        return `Rotated UV by ${angle} degrees for ${affected.length} faces of mesh "${mesh.name}"`;
      },
    },
    uvToolDocs[2].status
  );
}
