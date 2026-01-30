/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import { findMeshOrThrow, getMeshOrSelected } from "@/lib/util";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";
import {
  meshIdSchema,
  meshIdOptionalSchema,
  vector2Schema,
  uvMappingModeEnum,
} from "@/lib/zodObjects";

export function registerUVTools() {
createTool(
    "set_mesh_uv",
    {
        description: "Sets UV coordinates for mesh faces or vertices.",
        annotations: {
            title: "Set Mesh UV",
            destructiveHint: true,
        },
        parameters: z.object({
            mesh_id: meshIdSchema,
            face_key: z.string().describe("Face key to set UV for."),
            uv_mapping: z
                .record(
                    z.string(), // vertex key
                    vector2Schema // UV coordinates
                )
                .describe("UV coordinates for each vertex of the face."),
        }),
        async execute({ mesh_id, face_key, uv_mapping }) {
            const mesh = findMeshOrThrow(mesh_id);

            Undo.initEdit({
                elements: [mesh],
                uv_only: true,
            });

            const face = mesh.faces[face_key];
            if (!face) {
                throw new Error(`Face with key "${face_key}" not found in mesh.`);
            }

            // Set UV coordinates for each vertex
            Object.entries(uv_mapping).forEach(([vkey, uv]) => {
                if (face.vertices.includes(vkey)) {
                    face.uv[vkey] = uv;
                }
            });

            mesh.preview_controller.updateUV(mesh);
            UVEditor.loadData();

            Undo.finishEdit("Set mesh UV");

            return `Set UV mapping for face "${face_key}" of mesh "${mesh.name}"`;
        },
    },
    STATUS_EXPERIMENTAL
);

createTool(
    "auto_uv_mesh",
    {
        description: "Automatically generates UV mapping for selected mesh faces.",
        annotations: {
            title: "Auto UV Mesh",
            destructiveHint: true,
        },
        parameters: z.object({
            mesh_id: meshIdOptionalSchema,
            mode: uvMappingModeEnum
                .default("project")
                .describe(
                    "UV mapping mode: project from view, unwrap, cylinder, or sphere mapping."
                ),
            faces: z
                .array(z.string())
                .optional()
                .describe(
                    "Specific face keys to UV map. If not provided, maps all selected faces."
                ),
        }),
        async execute({ mesh_id, mode, faces }) {
            const mesh = getMeshOrSelected(mesh_id);

            Undo.initEdit({
                elements: [mesh],
                uv_only: true,
            });

            const selectedFaces = faces || UVEditor.getSelectedFaces(mesh);

            if (mode === "project") {
                // Use project from view
                BarItems.uv_project_from_view.click();
            } else {
                // Manual UV mapping based on mode
                selectedFaces.forEach((fkey) => {
                    const face = mesh.faces[fkey];
                    if (!face) return;

                    if (mode === "unwrap") {
                        // Simple planar unwrap
                        UVEditor.setAutoSize(null, true, [fkey]);
                    } else if (mode === "cylinder") {
                        // Cylindrical mapping
                        const vertices = face.getSortedVertices();
                        vertices.forEach((vkey, i) => {
                            const vertex = mesh.vertices[vkey];
                            const angle = Math.atan2(vertex[0], vertex[2]);
                            const u =
                                ((angle + Math.PI) / (2 * Math.PI)) * Project.texture_width;
                            const v = ((vertex[1] + 8) / 16) * Project.texture_height;
                            face.uv[vkey] = [u, v];
                        });
                    } else if (mode === "sphere") {
                        // Spherical mapping
                        const vertices = face.getSortedVertices();
                        vertices.forEach((vkey) => {
                            const vertex = mesh.vertices[vkey];
                            const length = Math.sqrt(
                                vertex[0] ** 2 + vertex[1] ** 2 + vertex[2] ** 2
                            );
                            const theta = Math.acos(vertex[1] / length);
                            const phi = Math.atan2(vertex[0], vertex[2]);
                            const u =
                                ((phi + Math.PI) / (2 * Math.PI)) * Project.texture_width;
                            const v = (theta / Math.PI) * Project.texture_height;
                            face.uv[vkey] = [u, v];
                        });
                    }
                });
            }

            mesh.preview_controller.updateUV(mesh);
            UVEditor.loadData();

            Undo.finishEdit("Auto UV mesh");

            return `Applied ${mode} UV mapping to ${selectedFaces.length} faces of mesh "${mesh.name}"`;
        },
    },
    STATUS_EXPERIMENTAL
);

createTool(
    "rotate_mesh_uv",
    {
        description: "Rotates UV coordinates of selected mesh faces.",
        annotations: {
            title: "Rotate Mesh UV",
            destructiveHint: true,
        },
        parameters: z.object({
            mesh_id: meshIdOptionalSchema,
            angle: z
                .enum(["-90", "90", "180"])
                .default("90")
                .describe("Rotation angle in degrees."),
            faces: z
                .array(z.string())
                .optional()
                .describe(
                    "Specific face keys to rotate UV for. If not provided, rotates all selected faces."
                ),
        }),
        async execute({ mesh_id, angle, faces }) {
            const mesh = getMeshOrSelected(mesh_id);

            Undo.initEdit({
                elements: [mesh],
                uv_only: true,
            });

            const rotation = parseInt(angle);
            UVEditor.rotate(rotation);

            Undo.finishEdit("Rotate mesh UV");

            return `Rotated UV by ${angle} degrees for mesh "${mesh.name}"`;
        },
    },
    STATUS_EXPERIMENTAL
);
}