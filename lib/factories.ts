import type { IMCPTool, IMCPPrompt } from "@/types";
import { getServer } from "@/server/server";
import { z } from "zod";

const TOOL_PREFIX = "blockbench";

/**
 * User-visible list of tool details.
 */
export const tools: Record<string, IMCPTool> = {};

/**
 * User-visible list of prompt details.
 */
export const prompts: Record<string, IMCPPrompt> = {};

/**
 * Store tool definitions for dynamic server reconstruction
 */
const toolDefinitions: Record<string, any> = {};

/**
 * Creates a new MCP tool and stores it for server registration.
 * @param suffix - The suffix for the tool name (will be prefixed with "blockbench_").
 * @param tool - The tool configuration.
 * @param tool.description - The description of the tool.
 * @param tool.annotations - Annotations for the tool (including title).
 * @param tool.parameters - The Zod schema for parameters.
 * @param tool.execute - The function to execute when the tool is called.
 * @param status - The status of the tool.
 * @param enabled - Whether the tool is enabled.
 * @returns - The created tool metadata.
 * @throws - If a tool with the same name already exists.
 * @example
 * ```ts
 * createTool("my_tool", {
 *   description: "My tool description for the AI to read.",
 *   annotations: {
 *     title: "My tool description for the Human to read.",
 *   },
 *   parameters: z.object({
 *     name: z.string(),
 *   }),
 *   async execute({ name }) {
 *     return { message: `Hello, ${name}!` };
 *   },
 * });
 * ```
 */
export function createTool<T extends z.ZodRawShape>(
  suffix: string,
  tool: {
    description: string;
    annotations?: { title?: string; [key: string]: any };
    parameters?: z.ZodObject<T>;
    execute: (args: T extends z.ZodRawShape ? z.infer<z.ZodObject<T>> : any) => Promise<any>;
  },
  status: IMCPTool["status"] = "stable",
  enabled: boolean = true
) {
  const name = `${TOOL_PREFIX}_${suffix}`;
  if (tools[name]) {
    throw new Error(`Tool with name "${name}" already exists.`);
  }

  // Store tool definition for later use
  toolDefinitions[name] = tool;

  // Add to server if enabled
  if (enabled) {
    getServer().registerTool(
      name,
      {
        title: tool.annotations?.title,
        description: tool.description,
        inputSchema: tool.parameters,
      },
      async (args: any) => {
        const result = await tool.execute(args || {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      }
    );
  }

  tools[name] = {
    name,
    description: tool.annotations?.title ?? tool.description ?? `${name} tool`,
    enabled,
    status,
  };

  return tools[name];
}

/**
 * Gets all tool definitions for server reconstruction
 */
export function getAllToolDefinitions() {
  return toolDefinitions;
}

/**
 * Gets enabled tool definitions for server reconstruction
 */
export function getEnabledToolDefinitions() {
  return Object.fromEntries(
    Object.entries(toolDefinitions).filter(([name]) => tools[name]?.enabled)
  );
}

/**
 * Creates a new MCP prompt and adds it to the server.
 * @param suffix - The suffix for the prompt name (will be prefixed with "blockbench_").
 * @param prompt - The prompt configuration.
 * @param prompt.description - The description of the prompt.
 * @param prompt.argsSchema - The Zod schema for arguments.
 * @param prompt.callback - The function to execute when the prompt is loaded.
 * @param status - The status of the prompt.
 * @param enabled - Whether the prompt is enabled.
 * @returns - The created prompt metadata.
 * @throws - If a prompt with the same name already exists.
 */
export function createPrompt<T extends z.ZodRawShape>(
  suffix: string,
  prompt: {
    description: string;
    argsSchema?: z.ZodObject<T>;
    callback: (args: T extends z.ZodRawShape ? z.infer<z.ZodObject<T>> : any) => Promise<any>;
  },
  status: IMCPPrompt["status"] = "stable",
  enabled: boolean = true
) {
  const name = `${TOOL_PREFIX}_${suffix}`;

  if (prompts[name]) {
    throw new Error(`Prompt with name "${name}" already exists.`);
  }

  if (enabled) {
    getServer().registerPrompt(
      name,
      {
        title: name,
        description: prompt.description,
        argsSchema: prompt.argsSchema,
      },
      prompt.callback
    );
  }

  prompts[name] = {
    name,
    description: prompt.description,
    enabled,
    status,
  };

  return prompts[name];
}
