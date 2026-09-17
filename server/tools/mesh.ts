/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import {
  meshSchema,
  meshIdOptionalSchema,
  meshIdSchema,
  textureIdOptionalSchema,
  groupIdOptionalSchema,
  vector3Schema,
  meshSelectionModeEnum,
  selectionActionEnum,
} from "@/lib/zodObjects";
import { MAX_SUBDIVISION_CUTS, STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { getProjectTexture, getMeshOrSelected, findMeshOrThrow } from "@/lib/util";
import { deleteMeshSelection, extrudeMeshFaces, subdivideMeshFaces } from "@/lib/mesh-editing";
import {
  addCylinderGeometry,
  addIndexedGeometry,
  addNewMesh,
  addSphereGeometry,
  createMeshEdit,
  type IIndexedGeometryKeys,
  type IMeshCreationContext,
} from "@/lib/mesh-primitives";

// ============================================================================
// Mesh Tool Parameter Schemas
// ============================================================================

/** Parameters for batched mesh creation, including local geometry and optional material/group references. */
export const placeMeshParameters = z.object({
  elements: z
    .array(meshSchema)
    .min(1)
    .describe("Array of meshes to place."),
  texture: textureIdOptionalSchema.describe("Texture ID or name to apply to the mesh."),
  group: groupIdOptionalSchema.describe("Group/bone to which the mesh belongs."),
});

/** Face-region extrusion parameters; unsupported edge/vertex modes produce an actionable error. */
export const extrudeMeshParameters = z.object({
  mesh_id: meshIdOptionalSchema,
  distance: z.number().finite().refine(value => value !== 0, "Distance must be nonzero").default(1).describe("Signed distance along averaged selected face normals, in local model units."),
  mode: z
    .enum(["faces", "edges", "vertices"])
    .default("faces")
    .describe("Use faces. Edge and vertex extrusion are currently unsupported by this headless tool."),
});

/** Regular triangle/quad subdivision with cuts + 1 segments per edge. */
export const subdivideMeshParameters = z.object({
  mesh_id: meshIdOptionalSchema,
  cuts: z
    .number()
    .int()
    .min(1)
    .max(MAX_SUBDIVISION_CUTS)
    .default(1)
    .describe("Number of cuts per edge; each selected face becomes (cuts + 1) squared faces."),
});

/** Sphere primitive parameters; integer sides keep the generated rings closed and symmetric. */
export const createSphereParameters = z.object({
  elements: z
    .array(
      z.object({
        name: z.string().describe("Name of the sphere."),
        position: vector3Schema.describe("Position of the sphere center."),
        diameter: z
          .number()
          .min(1)
          .max(64)
          .default(16)
          .describe("Diameter of the sphere."),
        sides: z
          .number()
          .int()
          .min(3)
          .max(48)
          .default(12)
          .describe(
            "Number of horizontal divisions (affects sphere quality)."
          ),
        rotation: vector3Schema
          .optional()
          .default([0, 0, 0])
          .describe("Rotation of the sphere."),
        align_edges: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether to align edges for better geometry."),
      })
    )
    .min(1)
    .describe("Array of spheres to create."),
  texture: textureIdOptionalSchema.describe("Texture ID or name to apply to the sphere."),
  group: groupIdOptionalSchema.describe("Group/bone to which the sphere belongs."),
});

/** Select mesh components using the keys returned by mesh creation or inspection. */
export const selectMeshElementsParameters = z.object({
  mesh_id: meshIdSchema.describe("ID or name of the mesh to select elements from."),
  mode: meshSelectionModeEnum.describe("Selection mode."),
  elements: z
    .array(
      z.union([
        z
          .string()
          .describe("Vertex key, edge as 'vkey1-vkey2', or face key"),
        z.number().describe("Index of the element"),
      ])
    )
    .optional()
    .describe("Specific elements to select. If not provided, selects all."),
  action: selectionActionEnum
    .default("select")
    .describe(
      "Selection action: select (replace), add, remove, or toggle."
    ),
});

/** Offset explicit vertex keys, or the mesh's current vertex selection, in local units. */
export const moveMeshVerticesParameters = z.object({
  mesh_id: meshIdOptionalSchema,
  offset: vector3Schema.describe("Offset to move vertices by [x, y, z]."),
  vertices: z
    .array(z.string())
    .optional()
    .describe(
      "Specific vertex keys to move. If not provided, moves all selected vertices."
    ),
});

/** Component deletion removes incident faces and optionally retains resulting orphan vertices. */
export const deleteMeshElementsParameters = z.object({
  mesh_id: meshIdOptionalSchema,
  mode: z
    .enum(["vertices", "edges", "faces"])
    .default("faces")
    .describe("What to delete: vertices, edges, or faces."),
  keep_vertices: z
    .boolean()
    .default(false)
    .describe("When deleting faces/edges, whether to keep the vertices."),
});

/** Distance-threshold vertex merge over selected or all vertices of a named mesh. */
export const mergeMeshVerticesParameters = z.object({
  mesh_id: meshIdSchema,
  threshold: z
    .number()
    .min(0)
    .max(10)
    .default(0.1)
    .describe("Maximum distance between vertices to merge."),
  selected_only: z
    .boolean()
    .default(true)
    .describe("Whether to only merge selected vertices."),
});

/** Build one triangle/quad from existing vertex keys, optionally assigning a texture. */
export const createMeshFaceParameters = z.object({
  mesh_id: meshIdOptionalSchema,
  vertices: z
    .array(z.string())
    .min(3)
    .max(4)
    .describe("Vertex keys to create face from. Must be 3 or 4 vertices."),
  texture: textureIdOptionalSchema.describe("Texture ID or name to apply to the new face."),
});

/** Cylinder primitive parameters with optional end caps and integer radial segments. */
export const createCylinderParameters = z.object({
  elements: z
    .array(
      z.object({
        name: z.string(),
        position: vector3Schema,
        height: z.number().min(1).max(64).default(16),
        diameter: z.number().min(1).max(64).default(16),
        sides: z.number().int().min(3).max(64).default(12),
        rotation: vector3Schema.optional().default([0, 0, 0]),
        capped: z.boolean().optional().default(true),
      })
    )
    .min(1),
  texture: textureIdOptionalSchema,
  group: groupIdOptionalSchema,
});

/** Retained for contract stability; knife_tool validates the mesh, then reports that headless cuts are unsupported. */
export const knifeToolParameters = z.object({
  mesh_id: meshIdSchema.describe("ID or name of the mesh to cut."),
  points: z
    .array(
      z.object({
        position: vector3Schema.describe("3D position of the cut point."),
        face: z
          .string()
          .optional()
          .describe("Face key to attach the point to."),
      })
    )
    .min(2)
    .describe("Points defining the cut path."),
});

// ============================================================================
// Mesh Tool Docs
// ============================================================================

/**
 * Static specs for every mesh tool, shared by {@link registerMeshTools} and the docs generator.
 *
 * Registration addresses entries by index, so the order is part of the contract:
 * place_mesh, extrude_mesh, subdivide_mesh, create_sphere, select_mesh_elements,
 * move_mesh_vertices, delete_mesh_elements, merge_mesh_vertices, create_mesh_face,
 * create_cylinder, knife_tool. Building this array touches no Blockbench globals.
 */
export const meshToolDocs: IToolSpec[] = [
  {
    name: "place_mesh",
    condition: { project: true, features: ["meshes"] },
    description:
      "Creates meshes from local vertices and optional indexed triangle/quad faces, with position, rotation, and scale. Texture and group are optional. Returns meshes with UUIDs and vertex_keys/face_keys arrays in input order for subsequent editing.",
    annotations: {
      title: "Place Mesh",
      destructiveHint: true,
    },
    parameters: placeMeshParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "extrude_mesh",
    condition: { project: true, features: ["meshes"] },
    description: "Extrudes the target mesh's selected face region along averaged normals, honoring distance. Returns new vertex keys and cap/wall face keys. Edge/vertex modes are unsupported.",
    annotations: {
      title: "Extrude Mesh",
      destructiveHint: true,
    },
    parameters: extrudeMeshParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "subdivide_mesh",
    condition: { project: true, features: ["meshes"] },
    description: "Subdivides the target mesh's selected triangles/quads into a regular grid with interpolated UVs. Returns new geometry keys. Unselected neighboring faces remain unchanged and may need matching cuts.",
    annotations: {
      title: "Subdivide Mesh",
      destructiveHint: true,
    },
    parameters: subdivideMeshParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "create_sphere",
    condition: { project: true, features: ["meshes"] },
    description:
      "Creates a sphere mesh at the specified position with the given parameters. The sphere is created as a mesh with vertices and faces using spherical coordinates.",
    annotations: {
      title: "Create Sphere",
      destructiveHint: true,
    },
    parameters: createSphereParameters,
    status: STATUS_STABLE,
  },
  {
    name: "select_mesh_elements",
    condition: { project: true, features: ["meshes"] },
    description:
      "Selects vertices, edges, or faces of a mesh for manipulation.",
    annotations: {
      title: "Select Mesh Elements",
      destructiveHint: true,
    },
    parameters: selectMeshElementsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "move_mesh_vertices",
    condition: { project: true, features: ["meshes"] },
    description: "Moves selected vertices of a mesh by the specified offset.",
    annotations: {
      title: "Move Mesh Vertices",
      destructiveHint: true,
    },
    parameters: moveMeshVerticesParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "delete_mesh_elements",
    condition: { project: true, features: ["meshes"] },
    description: "Deletes selected components only from the target mesh. Vertex/edge deletion removes incident faces; keep_vertices retains vertices orphaned by face/edge removal.",
    annotations: {
      title: "Delete Mesh Elements",
      destructiveHint: true,
    },
    parameters: deleteMeshElementsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "merge_mesh_vertices",
    condition: { project: true, features: ["meshes"] },
    description:
      "Merges vertices that are within a specified distance of each other.",
    annotations: {
      title: "Merge Mesh Vertices",
      destructiveHint: true,
    },
    parameters: mergeMeshVerticesParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "create_mesh_face",
    condition: { project: true, features: ["meshes"] },
    description: "Creates a new face from selected vertices.",
    annotations: {
      title: "Create Mesh Face",
      destructiveHint: true,
    },
    parameters: createMeshFaceParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "create_cylinder",
    condition: { project: true, features: ["meshes"] },
    description: "Creates one or more cylinder meshes with optional end caps.",
    annotations: { title: "Create Cylinder", destructiveHint: true },
    parameters: createCylinderParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "knife_tool",
    condition: false,
    description: "Currently unsupported for meshes: Blockbench's interactive Knife context requires pointer topology that this point-list API cannot safely provide. Use subdivide_mesh or place_mesh for meshes; use knife_cut_cube or slice_cubes_to_block_grid to cut cubes headlessly.",
    annotations: {
      title: "Knife Tool",
      destructiveHint: true,
    },
    parameters: knifeToolParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

// ============================================================================
// Registration
// ============================================================================

/** Per-mesh keys returned by place_mesh, in input order, for follow-up editing. */
interface IPlacedMesh extends IIndexedGeometryKeys {
  name: string;
  uuid: string;
}

/** Resolve references before beginning an edit so invalid inputs leave no undo state. */
function resolveMeshCreationContext(texture?: string, group?: string): IMeshCreationContext {
  if (!Project) {
    throw new Error("No project is open. Use create_project before creating meshes.");
  }
  if (!Format.meshes) {
    throw new Error(`Project format "${Format.id}" does not support meshes. Use a mesh-capable format such as "free".`);
  }

  const projectTexture = texture ? getProjectTexture(texture) : Texture.getDefault();
  if (texture && !projectTexture) {
    throw new Error(`Texture "${texture}" not found. Use list_textures to find a texture.`);
  }
  if (!group || group === "root") {
    return { projectTexture, outlinerGroup: "root" };
  }

  const outlinerGroup = Group.all.find((candidate) => candidate.name === group || candidate.uuid === group);
  if (!outlinerGroup) {
    throw new Error(`Group "${group}" not found. Use list_outline to find a group.`);
  }
  return { projectTexture, outlinerGroup };
}

/**
 * Registers every tool in {@link meshToolDocs} against the active Blockbench runtime.
 *
 * Creation tools validate references before opening a single undo edit per batch;
 * editing tools snapshot only the target mesh. Blockbench globals are accessed only
 * when a tool executes, never at registration.
 */
export function registerMeshTools(): void {
  createTool(meshToolDocs[0].name, {
    ...meshToolDocs[0],
    parameters: placeMeshParameters,
    async execute({ elements, texture, group }, context) {
      const creation = resolveMeshCreationContext(texture, group);
      const total = elements.length;
      elements.forEach((element) => {
        element.faces.forEach((face, faceIndex) => {
          if (new Set(face).size !== face.length || face.some((index) => index >= element.vertices.length)) {
            throw new Error(`Mesh "${element.name}" face ${faceIndex} must reference 3 or 4 distinct existing vertex indices.`);
          }
        });
      });

      const placed = createMeshEdit("Agent placed meshes", (created) => elements.map((element, index): IPlacedMesh => {
        const [mesh, keys] = addNewMesh(created, element, creation, (target) => addIndexedGeometry(target, element));
        context?.reportProgress({ progress: index + 1, total });
        return { name: mesh.name, uuid: mesh.uuid, ...keys };
      }));
      return JSON.stringify({ meshes: placed });
    },
  }, meshToolDocs[0].status);

  createTool(meshToolDocs[1].name, {
    ...meshToolDocs[1],
    parameters: extrudeMeshParameters,
    async execute({ mesh_id, distance, mode }) {
      const mesh = getMeshOrSelected(mesh_id);
      if (mode !== "faces") throw new Error("Headless extrusion currently supports mode 'faces' only. Select faces with select_mesh_elements, or create explicit edge/vertex geometry with place_mesh.");
      return JSON.stringify({ mesh: mesh.uuid, distance, ...extrudeMeshFaces(mesh, distance) });
    },
  }, meshToolDocs[1].status);

  createTool(meshToolDocs[2].name, {
    ...meshToolDocs[2],
    parameters: subdivideMeshParameters,
    async execute({ mesh_id, cuts }) {
      const mesh = getMeshOrSelected(mesh_id);
      return JSON.stringify({ mesh: mesh.uuid, cuts, ...subdivideMeshFaces(mesh, cuts) });
    },
  }, meshToolDocs[2].status);

  createTool(meshToolDocs[3].name, {
    ...meshToolDocs[3],
    parameters: createSphereParameters,
    async execute({ elements, texture, group }, context) {
      const creation = resolveMeshCreationContext(texture, group);
      const total = elements.length;
      const spheres = createMeshEdit("Agent created spheres", (created) => elements.map((element, index) => {
        const [mesh] = addNewMesh(created, element, creation, (target) => addSphereGeometry(target, element));
        context?.reportProgress({ progress: index + 1, total });
        return mesh;
      }));
      return JSON.stringify(spheres.map((sphere) => `Added sphere ${sphere.name} with ID ${sphere.uuid}`));
    },
  }, meshToolDocs[3].status);

  createTool(meshToolDocs[4].name, {
    ...meshToolDocs[4],
    parameters: selectMeshElementsParameters,
    async execute({ mesh_id, mode, elements, action }) {
      if (!Project) {
        throw new Error("No project is open. Open a project before selecting mesh elements.");
      }
      const mesh = findMeshOrThrow(mesh_id);

      Undo.initEdit({
        elements: [mesh],
        selection: true,
        collections: [],
      });

      // Object selection may clear component state. Preserve existing keys for
      // add/remove/toggle and finish that lifecycle before installing the result.
      const previousSelection = Project.mesh_selection[mesh.uuid];
      mesh.select();

      // Set selection mode
      // @ts-expect-error Selection mode setter available at runtime
      BarItems.selection_mode.set(mode);
      const selection = (Project.mesh_selection[mesh.uuid] ??= previousSelection ??
      {
        vertices: [],
        edges: [],
        faces: [],
      }) as {
        vertices: string[];
        edges: unknown[];
        faces: string[];
      };

      if (action === "select") {
        // Clear existing selection
        selection.vertices = [];
        selection.edges.length = 0;
        selection.faces = [];
      }

      if (!elements || elements.length === 0) {
        // Select all elements of the specified type
        if (mode === "vertex") {
          selection.vertices = Object.keys(mesh.vertices);
        } else if (mode === "face") {
          selection.faces = Object.keys(mesh.faces);
        } else if (mode === "edge") {
          // Collect all unique edges from faces
          const allEdges: [string, string][] = [];
          const seen = new Set<string>();
          for (const fkey in mesh.faces) {
            const face = mesh.faces[fkey];
            const edges = (face.getEdges() as unknown as [string, string][]);
            for (const [a, b] of edges) {
              const key = a < b ? `${a}-${b}` : `${b}-${a}`;
              if (!seen.has(key)) {
                seen.add(key);
                allEdges.push([a, b]);
              }
            }
          }
          const selEdges = selection.edges as unknown as [string, string][];
          selEdges.length = 0;
          selEdges.push(...allEdges);
        }
      } else {
        // Select specific elements
        elements.forEach((element) => {
          if (mode === "vertex") {
            const vkey = String(element);
            if (action === "add" || action === "select") {
              if (!selection.vertices.includes(vkey)) {
                selection.vertices.push(vkey);
              }
            } else if (action === "remove") {
              selection.vertices = selection.vertices.filter((k) => k !== vkey);
            } else if (action === "toggle") {
              if (selection.vertices.includes(vkey)) {
                selection.vertices = selection.vertices.filter((k) => k !== vkey);
              } else {
                selection.vertices.push(vkey);
              }
            }
          } else if (mode === "face") {
            const fkey = String(element);
            if (action === "add" || action === "select") {
              if (!selection.faces.includes(fkey)) {
                selection.faces.push(fkey);
              }
            } else if (action === "remove") {
              selection.faces = selection.faces.filter((k) => k !== fkey);
            } else if (action === "toggle") {
              if (selection.faces.includes(fkey)) {
                selection.faces = selection.faces.filter((k) => k !== fkey);
              } else {
                selection.faces.push(fkey);
              }
            }
          } else if (mode === "edge") {
            // Parse edge format "vkey1-vkey2"
            const edgeParts = String(element).split("-");
            if (edgeParts.length === 2) {
              const edge: [string, string] = [edgeParts[0], edgeParts[1]];
              const selEdges = selection.edges as unknown as [string, string][];
              if (action === "add" || action === "select") {
                selEdges.push(edge);
              } else if (action === "remove") {
                const filtered = selEdges.filter(
                  (e) =>
                    !(e[0] === edge[0] && e[1] === edge[1]) &&
                    !(e[0] === edge[1] && e[1] === edge[0])
                );
                selEdges.length = 0;
                selEdges.push(...filtered);
              } else if (action === "toggle") {
                const exists = selEdges.some(
                  (e) =>
                    (e[0] === edge[0] && e[1] === edge[1]) ||
                    (e[0] === edge[1] && e[1] === edge[0])
                );
                if (exists) {
                  const filtered = selEdges.filter(
                    (e) =>
                      !(e[0] === edge[0] && e[1] === edge[1]) &&
                      !(e[0] === edge[1] && e[1] === edge[0])
                  );
                  selEdges.length = 0;
                  selEdges.push(...filtered);
                } else {
                  selEdges.push(edge);
                }
              }
            }
          }
        });
      }

      Canvas.updateView({
        elements: [mesh],
        selection: true,
      });

      Undo.finishEdit("Select mesh elements");

      return JSON.stringify({
        mesh: mesh.name,
        mode,
        selected: {
          vertices: selection.vertices.length,
          edges: selection.edges.length,
          faces: selection.faces.length,
        },
      });
    },
  }, meshToolDocs[4].status);

  createTool(meshToolDocs[5].name, {
    ...meshToolDocs[5],
    parameters: moveMeshVerticesParameters,
    async execute({ mesh_id, offset, vertices }) {
      const mesh = getMeshOrSelected(mesh_id);

      Undo.initEdit({
        elements: [mesh],
      });

      const verticesToMove = vertices || mesh.getSelectedVertices();

      verticesToMove.forEach((vkey) => {
        if (mesh.vertices[vkey]) {
          mesh.vertices[vkey][0] += offset[0];
          mesh.vertices[vkey][1] += offset[1];
          mesh.vertices[vkey][2] += offset[2];
        }
      });

      mesh.preview_controller.updateGeometry(mesh);

      Undo.finishEdit("Move mesh vertices");
      Canvas.updateView({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      return `Moved ${verticesToMove.length} vertices of mesh "${mesh.name}"`;
    },
  }, meshToolDocs[5].status);

  createTool(meshToolDocs[6].name, {
    ...meshToolDocs[6],
    parameters: deleteMeshElementsParameters,
    async execute({ mesh_id, mode, keep_vertices }) {
      const mesh = getMeshOrSelected(mesh_id);
      return JSON.stringify({ mesh: mesh.uuid, ...deleteMeshSelection(mesh, mode, keep_vertices) });
    },
  }, meshToolDocs[6].status);

  createTool(meshToolDocs[7].name, {
    ...meshToolDocs[7],
    async execute({ mesh_id, threshold, selected_only }) {
      const mesh = findMeshOrThrow(mesh_id);

      Undo.initEdit({
        elements: [mesh],
      });

      const verticesToCheck = selected_only
        ? mesh.getSelectedVertices()
        : Object.keys(mesh.vertices);

      let mergedCount = 0;
      const mergeMap: Record<string, string> = {};

      // Find vertices to merge
      for (let i = 0; i < verticesToCheck.length; i++) {
        const vkey1 = verticesToCheck[i];
        if (mergeMap[vkey1]) continue;

        for (let j = i + 1; j < verticesToCheck.length; j++) {
          const vkey2 = verticesToCheck[j];
          if (mergeMap[vkey2]) continue;

          const v1 = mesh.vertices[vkey1];
          const v2 = mesh.vertices[vkey2];
          const distance = Math.sqrt(
            (v1[0] - v2[0]) ** 2 + (v1[1] - v2[1]) ** 2 + (v1[2] - v2[2]) ** 2
          );

          if (distance <= threshold) {
            mergeMap[vkey2] = vkey1;
            mergedCount++;
          }
        }
      }

      // Apply merges
      Object.entries(mergeMap).forEach(([oldKey, newKey]) => {
        // Update faces
        for (const fkey in mesh.faces) {
          const face = mesh.faces[fkey];
          const index = face.vertices.indexOf(oldKey);
          if (index !== -1) {
            face.vertices[index] = newKey;
            face.uv[newKey] = face.uv[oldKey] || [0, 0];
            delete face.uv[oldKey];
          }
        }
        // Remove merged vertex
        delete mesh.vertices[oldKey];
      });

      mesh.preview_controller.updateGeometry(mesh);

      Undo.finishEdit("Merge mesh vertices");
      Canvas.updateView({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      return `Merged ${mergedCount} vertices in mesh "${mesh.name}"`;
    },
  }, meshToolDocs[7].status);

  createTool(meshToolDocs[8].name, {
    ...meshToolDocs[8],
    async execute({ mesh_id, vertices, texture }) {
      const mesh = getMeshOrSelected(mesh_id);

      Undo.initEdit({
        elements: [mesh],
      });

      // Create the face
      const face = new MeshFace(mesh, {
        vertices,
        texture: texture ? getProjectTexture(texture)?.uuid : undefined,
      });

      const [faceKey] = mesh.addFaces(face);

      // Auto UV the new face
      UVEditor.setAutoSize(null, true, [faceKey]);

      mesh.preview_controller.updateGeometry(mesh);
      mesh.preview_controller.updateUV(mesh);

      Undo.finishEdit("Create mesh face");
      Canvas.updateView({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      return `Created face with ${vertices.length} vertices in mesh "${mesh.name}"`;
    },
  }, meshToolDocs[8].status);

  createTool(meshToolDocs[9].name, {
    ...meshToolDocs[9],
    parameters: createCylinderParameters,
    async execute({ elements, texture, group }, context) {
      const creation = resolveMeshCreationContext(texture, group);
      const total = elements.length;
      const cylinders = createMeshEdit("Agent created cylinders", (created) => elements.map((element, index) => {
        const [mesh] = addNewMesh(created, element, creation, (target) => addCylinderGeometry(target, element));
        context?.reportProgress({ progress: index + 1, total });
        return mesh;
      }));
      return JSON.stringify(cylinders.map((c) => `Added cylinder ${c.name} (ID ${c.uuid})`));
    },
  }, meshToolDocs[9].status);

  createTool(meshToolDocs[10].name, {
    ...meshToolDocs[10],
    async execute({ mesh_id }) {
      findMeshOrThrow(mesh_id);
      throw new Error("Headless knife_tool is unsupported for meshes: Blockbench requires interactive pointer/edge topology. Use subdivide_mesh or place_mesh for meshes, or knife_cut_cube / slice_cubes_to_block_grid for cubes.");
    },
  }, meshToolDocs[10].status);
}
