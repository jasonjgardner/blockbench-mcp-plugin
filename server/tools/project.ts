/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import { STATUS_STABLE } from "@/lib/constants";

createTool(
  "create_project",
  {
    description: "Creates a new project with the given name and project type.",
    annotations: {
      title: "Create Project",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      name: z.string(),
      format: z
        .enum(Object.keys(Formats) as [string, ...string[]])
        .default("bedrock_block"),
    }),
    async execute({ name, format }) {
      const created = newProject(Formats[format]);

      if (!created) {
        throw new Error("Failed to create project.");
      }

      Project!.name = name;

      return `Created project with name "${name}" (UUID: ${Project?.uuid}) and format "${format}".`;
    },
  },
  STATUS_STABLE
);
