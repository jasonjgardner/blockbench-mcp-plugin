/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import { meshSchema } from "@/lib/zodObjects";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";

createTool(
    "place_mesh",
    {
        description:
            "Places a mesh at the specified position. Texture and group are optional.",
        annotations: {
            title: "Place Mesh",
            destructiveHint: true,
        },
        parameters: z.object({
            elements: z
                .array(
                    meshSchema
                )
                .min(1)
                .describe("Array of meshes to place."),
            texture: z
                .string()
                .optional()
                .describe("Texture ID or name to apply to the mesh."),
            group: z
                .string()
                .optional()
                .describe("Group/bone to which the mesh belongs."),
        }),
        async execute({ elements, texture, group }, { reportProgress }) {
            Undo.initEdit({
                elements: [],
                outliner: true,
                collections: [],
            });
            const total = elements.length;

            const projectTexture = texture
                // @ts-expect-error Blockbench global utility available at runtime
                ? getProjectTexture(texture)
                : Texture.getDefault();

            if (!projectTexture) {
                throw new Error(`No texture found for "${texture}".`);
            }

            // @ts-expect-error getAllGroups is a utility function that returns all groups in the project
            const groups = getAllGroups();
            const outlinerGroup = groups.find(
                (g: Group) => g.name === group || g.uuid === group
            );

            const meshes = elements.map((element, progress) => {
                const mesh = new Mesh({
                    name: element.name,
                    vertices: {},
                }).init();

                element.vertices.forEach((vertex) => {
                    mesh.addVertices(vertex as ArrayVector3);
                });

                mesh.addTo(outlinerGroup);
                mesh.applyTexture(projectTexture);

                reportProgress({
                    progress,
                    total,
                });

                return mesh;
            });

            Undo.finishEdit("Agent placed meshes");
            Canvas.updateAll();

            return await Promise.resolve(
                JSON.stringify(
                    meshes.map((mesh) => `Added mesh ${mesh.name} with ID ${mesh.uuid}`)
                )
            );
        },
    },
    STATUS_EXPERIMENTAL
);

createTool(
    "extrude_mesh",
    {
        description: "Extrudes selected faces or edges of a mesh.",
        annotations: {
            title: "Extrude Mesh",
            destructiveHint: true,
        },
        parameters: z.object({
            mesh_id: z
                .string()
                .optional()
                .describe(
                    "ID or name of the mesh. If not provided, uses selected mesh."
                ),
            distance: z.number().default(1).describe("Distance to extrude."),
            mode: z
                .enum(["faces", "edges", "vertices"])
                .default("faces")
                .describe("What to extrude: faces, edges, or vertices."),
        }),
        async execute({ mesh_id, distance, mode }) {
            const mesh = mesh_id
                ? Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id)
                : Mesh.selected[0];

            if (!mesh) {
                throw new Error(
                    mesh_id ? `Mesh with ID "${mesh_id}" not found.` : "No mesh selected."
                );
            }

            // Use the extrude tool
            const tool =
                mode === "faces"
                    ? BarItems.extrude_mesh_selection
                    : mode === "edges"
                        ? BarItems.extrude_mesh_selection
                        : BarItems.extrude_mesh_selection;

            if (!tool) {
                throw new Error(`Extrude tool for ${mode} not found.`);
            }

            // @ts-ignore
            tool.click({}, distance);

            return `Extruded ${mode} of mesh "${mesh.name}" by ${distance} units`;
        },
    },
    STATUS_EXPERIMENTAL
);

createTool(
    "subdivide_mesh",
    {
        description: "Subdivides selected faces of a mesh to create more geometry.",
        annotations: {
            title: "Subdivide Mesh",
            destructiveHint: true,
        },
        parameters: z.object({
            mesh_id: z
                .string()
                .optional()
                .describe(
                    "ID or name of the mesh. If not provided, uses selected mesh."
                ),
            cuts: z
                .number()
                .min(1)
                .max(10)
                .default(1)
                .describe("Number of subdivision cuts to make."),
        }),
        async execute({ mesh_id, cuts }) {
            const mesh = mesh_id
                ? Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id)
                : Mesh.selected[0];

            if (!mesh) {
                throw new Error(
                    mesh_id ? `Mesh with ID "${mesh_id}" not found.` : "No mesh selected."
                );
            }

            // Use the loop cut tool with subdivision
            const tool = BarItems.loop_cut;
            if (!tool) {
                throw new Error("Loop cut tool not found.");
            }

            // @ts-ignore
            tool.click({}, undefined, undefined, cuts);

            return `Subdivided mesh "${mesh.name}" with ${cuts} cuts`;
        },
    },
    STATUS_EXPERIMENTAL
);


createTool(
    "create_sphere",
    {
        description:
            "Creates a sphere mesh at the specified position with the given parameters. The sphere is created as a mesh with vertices and faces using spherical coordinates.",
        annotations: {
            title: "Create Sphere",
            destructiveHint: true,
        },
        parameters: z.object({
            elements: z
                .array(
                    z.object({
                        name: z.string().describe("Name of the sphere."),
                        position: z
                            .array(z.number()).length(3)
                            .describe("Position of the sphere center."),
                        diameter: z
                            .number()
                            .min(1)
                            .max(64)
                            .default(16)
                            .describe("Diameter of the sphere."),
                        sides: z
                            .number()
                            .min(3)
                            .max(48)
                            .default(12)
                            .describe(
                                "Number of horizontal divisions (affects sphere quality)."
                            ),
                        rotation: z
                            .array(z.number()).length(3)
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
            texture: z
                .string()
                .optional()
                .describe("Texture ID or name to apply to the sphere."),
            group: z
                .string()
                .optional()
                .describe("Group/bone to which the sphere belongs."),
        }),
        async execute({ elements, texture, group }, { reportProgress }) {
            Undo.initEdit({
                elements: [],
                outliner: true,
                collections: [],
            });
            const total = elements.length;

            const projectTexture = texture
                // @ts-expect-error Blockbench global utility available at runtime
                ? getProjectTexture(texture)
                : Texture.getDefault();

            if (!projectTexture) {
                throw new Error(`No texture found for "${texture}".`);
            }

            // @ts-expect-error getAllGroups is a utility function that returns all groups in the project
            const groups = getAllGroups();
            const outlinerGroup = groups.find(
                (g) => g.name === group || g.uuid === group
            );

            const spheres = elements.map((element, progress) => {
                const mesh = new Mesh({
                    name: element.name,
                    vertices: {},
                    origin: element.position as [number, number, number],
                    rotation: (element.rotation || [0, 0, 0]) as [
                        number,
                        number,
                        number
                    ],
                }).init();

                // Create sphere vertices using spherical coordinates
                const radius = element.diameter / 2;
                const sides = Math.round(element.sides / 2) * 2; // Ensure even number for symmetry

                // Add top and bottom vertices
                const [bottom] = mesh.addVertices([0, -radius, 0]);
                const [top] = mesh.addVertices([0, radius, 0]);

                const rings: string[][] = [];
                const off_ang = element.align_edges ? 0.5 : 0;

                // Create rings of vertices
                for (let i = 0; i < element.sides; i++) {
                    const circle_x = Math.sin(
                        ((i + off_ang) / element.sides) * Math.PI * 2
                    );
                    const circle_z = Math.cos(
                        ((i + off_ang) / element.sides) * Math.PI * 2
                    );

                    const vertices: string[] = [];
                    for (let j = 1; j < sides / 2; j++) {
                        const slice_x = Math.sin((j / sides) * Math.PI * 2) * radius;
                        const x = circle_x * slice_x;
                        const y = Math.cos((j / sides) * Math.PI * 2) * radius;
                        const z = circle_z * slice_x;
                        vertices.push(...mesh.addVertices([x, y, z]));
                    }
                    rings.push(vertices);
                }

                // Create faces
                for (let i = 0; i < element.sides; i++) {
                    const this_ring = rings[i];
                    const next_ring = rings[i + 1] || rings[0];

                    for (let j = 0; j < sides / 2; j++) {
                        if (j == 0) {
                            // Connect to top vertex
                            mesh.addFaces(
                                new MeshFace(mesh, {
                                    vertices: [this_ring[j], next_ring[j], top],
                                    uv: {},
                                })
                            );
                            continue;
                        }

                        if (!this_ring[j]) {
                            // Connect to bottom vertex
                            mesh.addFaces(
                                new MeshFace(mesh, {
                                    vertices: [next_ring[j - 1], this_ring[j - 1], bottom],
                                    uv: {},
                                })
                            );
                            continue;
                        }

                        // Connect ring segments
                        mesh.addFaces(
                            new MeshFace(mesh, {
                                vertices: [
                                    this_ring[j],
                                    next_ring[j],
                                    this_ring[j - 1],
                                    next_ring[j - 1],
                                ],
                                uv: {},
                            })
                        );
                    }
                }

                mesh.addTo(outlinerGroup);
                if (projectTexture) {
                    mesh.applyTexture(projectTexture);
                }

                reportProgress({
                    progress,
                    total,
                });

                return mesh;
            });

            Undo.finishEdit("Agent created spheres");
            Canvas.updateAll();

            return await Promise.resolve(
                JSON.stringify(
                    spheres.map(
                        (sphere) => `Added sphere ${sphere.name} with ID ${sphere.uuid}`
                    )
                )
            );
        },
    },
    STATUS_STABLE
);

createTool(
    "select_mesh_elements",
    {
        description:
            "Selects vertices, edges, or faces of a mesh for manipulation.",
        annotations: {
            title: "Select Mesh Elements",
            destructiveHint: true,
        },
        parameters: z.object({
            mesh_id: z
                .string()
                .describe("ID or name of the mesh to select elements from."),
            mode: z.enum(["vertex", "edge", "face"]).describe("Selection mode."),
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
            action: z
                .enum(["select", "add", "remove", "toggle"])
                .default("select")
                .describe(
                    "Selection action: select (replace), add, remove, or toggle."
                ),
        }),
        async execute({ mesh_id, mode, elements, action }) {
            const mesh = Mesh.all.find(
                (m) => m.uuid === mesh_id || m.name === mesh_id
            );
            if (!mesh) {
                throw new Error(`Mesh with ID "${mesh_id}" not found.`);
            }

            Undo.initEdit({
                elements: [mesh],
                selection: true,
                collections: [],
            });

            // Set selection mode
            // @ts-expect-error Selection mode setter available at runtime
            BarItems.selection_mode.set(mode);
            const selection = (Project?.mesh_selection[mesh.uuid] ??
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
                        // @ts-expect-error MeshFace#getEdges exists at runtime
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

            mesh.select();
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
    },
    STATUS_EXPERIMENTAL
);

createTool(
    "move_mesh_vertices",
    {
        description: "Moves selected vertices of a mesh by the specified offset.",
        annotations: {
            title: "Move Mesh Vertices",
            destructiveHint: true,
        },
        parameters: z.object({
            mesh_id: z
                .string()
                .optional()
                .describe(
                    "ID or name of the mesh. If not provided, uses selected mesh."
                ),
            offset: z
                .array(z.number()).length(3)
                .describe("Offset to move vertices by [x, y, z]."),
            vertices: z
                .array(z.string())
                .optional()
                .describe(
                    "Specific vertex keys to move. If not provided, moves all selected vertices."
                ),
        }),
        async execute({ mesh_id, offset, vertices }) {
            const mesh = mesh_id
                ? Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id)
                : Mesh.selected[0];

            if (!mesh) {
                throw new Error(
                    mesh_id ? `Mesh with ID "${mesh_id}" not found.` : "No mesh selected."
                );
            }

            Undo.initEdit({
                elements: [mesh],
                element_aspects: {
                    geometry: true,
                    uv: true,
                    faces: true,
                },
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
    },
    STATUS_EXPERIMENTAL
);

createTool(
    "delete_mesh_elements",
    {
        description: "Deletes selected vertices, edges, or faces from a mesh.",
        annotations: {
            title: "Delete Mesh Elements",
            destructiveHint: true,
        },
        parameters: z.object({
            mesh_id: z
                .string()
                .optional()
                .describe(
                    "ID or name of the mesh. If not provided, uses selected mesh."
                ),
            mode: z
                .enum(["vertices", "edges", "faces"])
                .default("faces")
                .describe("What to delete: vertices, edges, or faces."),
            keep_vertices: z
                .boolean()
                .default(false)
                .describe("When deleting faces/edges, whether to keep the vertices."),
        }),
        async execute({ mesh_id, mode, keep_vertices }) {
            const mesh = mesh_id
                ? Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id)
                : Mesh.selected[0];

            if (!mesh) {
                throw new Error(
                    mesh_id ? `Mesh with ID "${mesh_id}" not found.` : "No mesh selected."
                );
            }

            // Use the delete tool
            const tool = BarItems.delete_mesh_selection;
            if (!tool) {
                throw new Error("Delete mesh selection tool not found.");
            }

            // @ts-ignore
            tool.click({}, keep_vertices);

            return `Deleted selected ${mode} from mesh "${mesh.name}"`;
        },
    },
    STATUS_EXPERIMENTAL
);

createTool(
    "merge_mesh_vertices",
    {
        description:
            "Merges vertices that are within a specified distance of each other.",
        annotations: {
            title: "Merge Mesh Vertices",
            destructiveHint: true,
        },
        parameters: z.object({
            mesh_id: z.string().describe("ID or name of the mesh."),
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
        }),
        async execute({ mesh_id, threshold, selected_only }) {
            const mesh = Mesh.all.find(
                (m) => m.uuid === mesh_id || m.name === mesh_id
            );
            if (!mesh) {
                throw new Error(`Mesh with ID "${mesh_id}" not found.`);
            }

            Undo.initEdit({
                elements: [mesh],
                element_aspects: {
                    geometry: true,
                    uv: true,
                    faces: true,
                },
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
    },
    STATUS_EXPERIMENTAL
);

createTool(
    "create_mesh_face",
    {
        description: "Creates a new face from selected vertices.",
        annotations: {
            title: "Create Mesh Face",
            destructiveHint: true,
        },
        parameters: z.object({
            mesh_id: z
                .string()
                .optional()
                .describe(
                    "ID or name of the mesh. If not provided, uses selected mesh."
                ),
            vertices: z
                .array(z.string())
                .min(3)
                .max(4)
                .describe("Vertex keys to create face from. Must be 3 or 4 vertices."),
            texture: z
                .string()
                .optional()
                .describe("Texture ID or name to apply to the new face."),
        }),
        async execute({ mesh_id, vertices, texture }) {
            const mesh = mesh_id
                ? Mesh.all.find((m) => m.uuid === mesh_id || m.name === mesh_id)
                : Mesh.selected[0];

            if (!mesh) {
                throw new Error(
                    mesh_id ? `Mesh with ID "${mesh_id}" not found.` : "No mesh selected."
                );
            }

            Undo.initEdit({
                elements: [mesh],
                element_aspects: {
                    geometry: true,
                    uv: true,
                    faces: true,
                },
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
    },
    STATUS_EXPERIMENTAL
);

createTool(
    "create_cylinder",
    {
        description: "Creates one or more cylinder meshes with optional end caps.",
        annotations: { title: "Create Cylinder", destructiveHint: true },
        parameters: z.object({
            elements: z
                .array(
                    z.object({
                        name: z.string(),
                        position: z.array(z.number()).length(3),
                        height: z.number().min(1).max(64).default(16),
                        diameter: z.number().min(1).max(64).default(16),
                        sides: z.number().min(3).max(64).default(12),
                        rotation: z
                            .array(z.number()).length(3)
                            .optional()
                            .default([0, 0, 0]),
                        capped: z.boolean().optional().default(true),
                    })
                )
                .min(1),
            texture: z.string().optional(),
            group: z.string().optional(),
        }),
        async execute({ elements, texture, group }, { reportProgress }) {
            Undo.initEdit({ elements: [], outliner: true, collections: [] });
            const total = elements.length;
            const projectTexture = texture
                ? getProjectTexture(texture)
                : Texture.getDefault();
            if (!projectTexture) throw new Error(`Texture "${texture}" not found.`);
            // @ts-expect-error getAllGroups is a utility function that returns all groups in the project
            const outlinerGroup = getAllGroups().find(
                (g) => g.name === group || g.uuid === group
            );
            const cylinders = elements.map((element, progress) => {
                const mesh = new Mesh({
                    name: element.name,
                    vertices: {},
                    origin: element.position as [number, number, number],
                    rotation: (element.rotation || [0, 0, 0]) as [
                        number,
                        number,
                        number
                    ],
                }).init();
                const radius = element.diameter / 2;
                const height = element.height;
                const sides = Math.round(element.sides);
                // centres for the caps
                const topCenter = mesh.addVertices([0, height / 2, 0])[0];
                const bottomCenter = mesh.addVertices([0, -height / 2, 0])[0];
                const topRing: any[] = [];
                const bottomRing: any[] = [];
                for (let i = 0; i < sides; i++) {
                    const ang = (i / sides) * Math.PI * 2;
                    const x = Math.cos(ang) * radius;
                    const z = Math.sin(ang) * radius;
                    topRing.push(mesh.addVertices([x, height / 2, z])[0]);
                    bottomRing.push(mesh.addVertices([x, -height / 2, z])[0]);
                }
                for (let i = 0; i < sides; i++) {
                    const next = (i + 1) % sides;
                    // side face
                    mesh.addFaces(
                        new MeshFace(mesh, {
                            vertices: [
                                bottomRing[i],
                                bottomRing[next],
                                topRing[next],
                                topRing[i],
                            ],
                            uv: {},
                        })
                    );
                    if (element.capped) {
                        // top cap (triangle fan)
                        mesh.addFaces(
                            new MeshFace(mesh, {
                                vertices: [topRing[i], topRing[next], topCenter],
                                uv: {},
                            })
                        );
                        // bottom cap
                        mesh.addFaces(
                            new MeshFace(mesh, {
                                vertices: [bottomRing[next], bottomRing[i], bottomCenter],
                                uv: {},
                            })
                        );
                    }
                }
                mesh.addTo(outlinerGroup);
                if (projectTexture) mesh.applyTexture(projectTexture);
                reportProgress({ progress, total });
                return mesh;
            });
            Undo.finishEdit("Agent created cylinders");
            Canvas.updateAll();
            return JSON.stringify(
                cylinders.map((c) => `Added cylinder ${c.name} (ID ${c.uuid})`)
            );
        },
    },
    STATUS_EXPERIMENTAL
);