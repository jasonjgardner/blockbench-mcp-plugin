/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { STATUS_STABLE } from "@/lib/constants";

export const createProjectParameters = z.object({
  name: z.string(),
  format: z
    .string()
    .default("bedrock_block")
    .describe("Project format ID from Blockbench's Formats registry."),
});

export const projectToolDocs: ToolSpec[] = [
  {
    name: "create_project",
    description: "Creates a new project with the given name and project type.",
    annotations: {
      title: "Create Project",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: createProjectParameters,
    status: STATUS_STABLE,
  },
];

export function registerProjectTools() {
  createTool(projectToolDocs[0].name, {
    ...projectToolDocs[0],
    async execute({ name, format }) {
      const created = newProject(Formats[format]);

      if (!created) {
        throw new Error("Failed to create project.");
      }

      Project!.name = name;

      return `Created project with name "${name}" (UUID: ${Project?.uuid}) and format "${format}".`;
    },
  }, projectToolDocs[0].status);
}
