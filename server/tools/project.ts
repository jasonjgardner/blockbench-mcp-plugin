/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import { STATUS_STABLE } from "@/lib/constants";
import { getProjectFileResource } from "@/lib/projectResources";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** New project name and native format ID, resolved against Formats at execution time. */
export const createProjectParameters = z.object({
  name: z.string(),
  format: z
    .string()
    .default("bedrock_block")
    .describe("Project format ID from Blockbench's Formats registry (e.g. bedrock_block, java_block, free). Unknown IDs are rejected with the list of valid IDs."),
});

/** Project inspection needs no arguments because it targets the active project. */
export const getProjectInfoParameters = z.object({});

/** Project creation/inspection metadata, safe for the documentation build to import. */
export const projectToolDocs: IToolSpec[] = [
  {
    name: "create_project",
    description: "Creates a project with the given name and format, and returns a resource link to its live .bbmodel file.",
    annotations: {
      title: "Create Project",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: createProjectParameters,
    status: STATUS_STABLE,
  },
  {
    name: "get_project_info",
    description:
      "Returns read-only project orientation: format id and display name, project name/UUID, texture resolution (texture_width/height), element counts, and a summary of top-level groups. Includes structured JSON and a resource link to the live .bbmodel project file. Prefer this over `risky_eval` for first-look inspection.",
    condition: { project: true },
    annotations: {
      title: "Get Project Info",
      readOnlyHint: true,
    },
    parameters: getProjectInfoParameters,
    status: STATUS_STABLE,
  },
];

/** Registers active-project tools; project resource bytes are compiled only when read. */
export function registerProjectTools(): void {
  createTool(projectToolDocs[0].name, {
    ...projectToolDocs[0],
    async execute({ name, format }): Promise<CallToolResult> {
      // newProject() is called directly: Blockbench 5.2's "New Project Dialog"
      // setting only applies to ModelFormat.new(), which would open a modal.
      // Own keys only, so inherited names like "toString" are rejected too.
      if (!Object.hasOwn(Formats, format)) {
        const validIds = Object.keys(Formats).toSorted().join(", ");
        throw new Error(`Unknown format "${format}". Valid format IDs: ${validIds}. Use get_capabilities for feature details.`);
      }
      const created = newProject(Formats[format]);
      const project = Project;
      if (!created || !project) {
        throw new Error("Failed to create project.");
      }

      project.name = name;

      return {
        content: [
          { type: "text", text: `Created project with name "${name}" (UUID: ${project.uuid}) and format "${format}".` },
          { type: "resource_link", ...getProjectFileResource(project) },
        ],
      };
    },
  }, projectToolDocs[0].status);

  createTool(projectToolDocs[1].name, {
    ...projectToolDocs[1],
    async execute(): Promise<CallToolResult> {
      if (!Project) {
        throw new Error(
          "No project is open. Use create_project to start a new one, or open an existing file in Blockbench."
        );
      }

      const format = Format as { id?: string; name?: string; display_name?: string } | undefined;

      const rootGroups = Outliner.root
        .filter((n): n is Group => n instanceof Group)
        .map((g) => ({
          name: g.name,
          uuid: g.uuid,
          children: g.children?.length ?? 0,
        }));

      const summary = {
        project: {
          name: Project.name,
          uuid: Project.uuid,
          save_path: (Project as { save_path?: string }).save_path ?? null,
        },
        format: {
          id: format?.id ?? null,
          name: format?.display_name ?? format?.name ?? null,
        },
        resolution: {
          texture_width: Project.texture_width ?? null,
          texture_height: Project.texture_height ?? null,
        },
        counts: {
          cubes: Cube.all.length,
          meshes: Mesh.all.length,
          groups: Group.all.length,
          textures: Texture.all.length,
          outliner_elements: Outliner.elements.length,
        },
        root_groups: rootGroups,
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(summary, null, 2) },
          { type: "resource_link", ...getProjectFileResource(Project) },
        ],
        structuredContent: summary,
      };
    },
  }, projectToolDocs[1].status);
}
