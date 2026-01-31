/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import { findElementOrThrow } from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { faceEnum } from "@/lib/zodObjects";

// Note: Blockbench API supports uv_only in UndoAspects but it's not in the type definitions

type CubeFaceDirection = z.infer<typeof faceEnum>;

/**
 * Helper to find a cube by ID or name
 */
function findCubeOrThrow(id: string): Cube {
  const element = findElementOrThrow(id);
  if (!(element instanceof Cube)) {
    throw new Error(`Element "${id}" is not a cube. Material instances are only supported on cube faces.`);
  }
  return element;
}

export function registerMaterialInstanceTools() {
  createTool(
    "get_face_material_instances",
    {
      description:
        "Gets the material instance names for cube faces. Material instances are used in Bedrock Block format to map faces to materials defined in the minecraft:material_instances component.",
      annotations: {
        title: "Get Face Material Instances",
        readOnlyHint: true,
      },
      parameters: z.object({
        cube_id: z
          .string()
          .optional()
          .describe(
            "ID or name of the cube. If not provided, uses the first selected cube."
          ),
        faces: z
          .array(faceEnum)
          .optional()
          .describe(
            "Specific faces to get material instances for. If not provided, returns all faces."
          ),
      }),
      async execute({ cube_id, faces }) {
        let cube: Cube;

        if (cube_id) {
          cube = findCubeOrThrow(cube_id);
        } else {
          if (!Cube.selected.length) {
            throw new Error(
              "No cube specified and no cube selected. Provide a cube_id or select a cube."
            );
          }
          cube = Cube.selected[0];
        }

        const facesToCheck = faces || faceEnum.options;
        const result: Record<string, { material_name: string; texture: string | null }> = {};

        for (const faceDir of facesToCheck) {
          const face = cube.faces[faceDir];
          if (face) {
            result[faceDir] = {
              material_name: face.material_name || "",
              texture: face.texture ? (face.getTexture()?.name || face.texture.toString()) : null,
            };
          }
        }

        return JSON.stringify({
          cube: {
            name: cube.name,
            uuid: cube.uuid,
          },
          faces: result,
        }, null, 2);
      },
    },
    STATUS_STABLE
  );

  createTool(
    "set_face_material_instance",
    {
      description:
        "Sets the material instance name for one or more cube faces. Material instances are strings that map to materials defined in the minecraft:material_instances component for Bedrock Block format.",
      annotations: {
        title: "Set Face Material Instance",
        destructiveHint: true,
      },
      parameters: z.object({
        cube_id: z
          .string()
          .optional()
          .describe(
            "ID or name of the cube. If not provided, applies to all selected cubes."
          ),
        material_name: z
          .string()
          .describe(
            "The material instance name to assign. Use empty string to clear the material instance."
          ),
        faces: z
          .array(faceEnum)
          .optional()
          .default(["north", "south", "east", "west", "up", "down"])
          .describe(
            "Faces to set the material instance on. Defaults to all faces."
          ),
      }),
      async execute({ cube_id, material_name, faces }) {
        let cubes: Cube[];

        if (cube_id) {
          cubes = [findCubeOrThrow(cube_id)];
        } else {
          if (!Cube.selected.length) {
            throw new Error(
              "No cube specified and no cubes selected. Provide a cube_id or select cubes."
            );
          }
          cubes = Cube.selected;
        }

        Undo.initEdit({
          elements: cubes,
          // @ts-expect-error - uv_only is a valid Blockbench API property
          uv_only: true,
        });

        let modifiedCount = 0;

        for (const cube of cubes) {
          for (const faceDir of faces) {
            const face = cube.faces[faceDir];
            if (face) {
              face.extend({ material_name });
              modifiedCount++;
            }
          }
        }

        Undo.finishEdit("Set material instances");
        Canvas.updateAll();

        return `Set material instance "${material_name}" on ${modifiedCount} face(s) across ${cubes.length} cube(s).`;
      },
    },
    STATUS_EXPERIMENTAL
  );

  createTool(
    "list_material_instances",
    {
      description:
        "Lists all unique material instance names used in the project. Returns the material instance names along with which cubes and faces use them.",
      annotations: {
        title: "List Material Instances",
        readOnlyHint: true,
      },
      parameters: z.object({}),
      async execute() {
        const materialMap: Record<
          string,
          Array<{ cube_name: string; cube_uuid: string; face: string }>
        > = {};

        for (const cube of Cube.all) {
          for (const faceDir of faceEnum.options) {
            const face = cube.faces[faceDir];
            if (face && face.material_name) {
              if (!materialMap[face.material_name]) {
                materialMap[face.material_name] = [];
              }
              materialMap[face.material_name].push({
                cube_name: cube.name,
                cube_uuid: cube.uuid,
                face: faceDir,
              });
            }
          }
        }

        const materialInstances = Object.entries(materialMap).map(
          ([name, usages]) => ({
            name,
            usage_count: usages.length,
            usages,
          })
        );

        return JSON.stringify({
          total_unique_instances: materialInstances.length,
          material_instances: materialInstances,
        }, null, 2);
      },
    },
    STATUS_STABLE
  );

  createTool(
    "bulk_set_material_instances",
    {
      description:
        "Sets material instance names on multiple cubes at once. Useful for assigning different material instances to different faces across the project.",
      annotations: {
        title: "Bulk Set Material Instances",
        destructiveHint: true,
      },
      parameters: z.object({
        assignments: z
          .array(
            z.object({
              cube_id: z.string().describe("ID or name of the cube."),
              faces: z
                .array(faceEnum)
                .describe("Faces to set the material instance on."),
              material_name: z.string().describe("Material instance name to assign."),
            })
          )
          .min(1)
          .describe("Array of material instance assignments."),
      }),
      async execute({ assignments }) {
        const cubeCache: Record<string, Cube> = {};
        const cubesToEdit: Cube[] = [];

        // Validate and cache cubes
        for (const assignment of assignments) {
          if (!cubeCache[assignment.cube_id]) {
            const cube = findCubeOrThrow(assignment.cube_id);
            cubeCache[assignment.cube_id] = cube;
            cubesToEdit.push(cube);
          }
        }

        Undo.initEdit({
          elements: cubesToEdit,
          // @ts-expect-error - uv_only is a valid Blockbench API property
          uv_only: true,
        });

        let totalModified = 0;

        for (const assignment of assignments) {
          const cube = cubeCache[assignment.cube_id];
          for (const faceDir of assignment.faces) {
            const face = cube.faces[faceDir];
            if (face) {
              face.extend({ material_name: assignment.material_name });
              totalModified++;
            }
          }
        }

        Undo.finishEdit("Bulk set material instances");
        Canvas.updateAll();

        return `Applied ${assignments.length} material instance assignment(s) affecting ${totalModified} face(s) on ${cubesToEdit.length} cube(s).`;
      },
    },
    STATUS_EXPERIMENTAL
  );

  createTool(
    "clear_material_instances",
    {
      description:
        "Clears (removes) material instance names from cube faces. Useful for resetting material assignments.",
      annotations: {
        title: "Clear Material Instances",
        destructiveHint: true,
      },
      parameters: z.object({
        cube_id: z
          .string()
          .optional()
          .describe(
            "ID or name of the cube. If not provided, clears from all selected cubes."
          ),
        faces: z
          .array(faceEnum)
          .optional()
          .describe(
            "Specific faces to clear. If not provided, clears all faces."
          ),
        all_cubes: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, clears material instances from all cubes in the project."
          ),
      }),
      async execute({ cube_id, faces, all_cubes }) {
        let cubes: Cube[];

        if (all_cubes) {
          cubes = Cube.all;
        } else if (cube_id) {
          cubes = [findCubeOrThrow(cube_id)];
        } else {
          if (!Cube.selected.length) {
            throw new Error(
              "No cube specified and no cubes selected. Provide a cube_id, select cubes, or set all_cubes=true."
            );
          }
          cubes = Cube.selected;
        }

        if (cubes.length === 0) {
          return "No cubes to process.";
        }

        Undo.initEdit({
          elements: cubes,
          // @ts-expect-error - uv_only is a valid Blockbench API property
          uv_only: true,
        });

        const facesToClear = faces || faceEnum.options;
        let clearedCount = 0;

        for (const cube of cubes) {
          for (const faceDir of facesToClear) {
            const face = cube.faces[faceDir];
            if (face && face.material_name) {
              face.extend({ material_name: "" });
              clearedCount++;
            }
          }
        }

        Undo.finishEdit("Clear material instances");
        Canvas.updateAll();

        return `Cleared material instances from ${clearedCount} face(s) across ${cubes.length} cube(s).`;
      },
    },
    STATUS_EXPERIMENTAL
  );
}
