import type { Tool, ToolParameters, Prompt, PromptArgument } from "fastmcp";
import type { IMCPTool, IMCPPrompt } from "@/types";
import { getServer } from "@/server/server";

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
const toolDefinitions: Record<
  string,
  Tool<Record<string, unknown> | undefined, any>
> = {};

/**
 * Creates a new MCP tool and stores it for server registration.
 * @param name - The name of the tool.
 * @param tool - The tool to add.
 * @param tool.description - The description of the tool.
 * @param tool.annotations - Annotations for the tool.
 * @param tool.parameters - The parameters for the tool.
 * @param tool.execute - The function to execute when the tool is called.
 * @param status - The status of the tool.
 * @param enabled - Whether the tool is enabled.
 * @returns - The created tool.
 * @throws - If a tool with the same name already exists.
 * @example
 * ```ts
 * createTool({
 *   name: "my_tool",
 *   description: "My tool description for the AI to read.",
 *   annotations: {
 *     title: "My tool description for the Human to read.",
 *     destructiveHint: true,
 *     openWorldHint: true,
 *   },
 *   parameters: z.object({
 *     name: z.string(),
 *   }),
 *   async execute({ name }) {
 *     console.log(`Hello, ${name}!`);
 *   },
 * });
 * ```
 */
export function createTool<T extends ToolParameters>(
  suffix: string,
  tool: Omit<Tool<Record<string, unknown> | undefined, T>, "name">,
  status: IMCPTool["status"] = "stable",
  enabled: boolean = true
) {
  const name = `${TOOL_PREFIX}_${suffix}`;
  if (tools[name]) {
    throw new Error(`Tool with name "${name}" already exists.`);
  }

  const fullTool = {
    ...(tool as Tool<Record<string, unknown> | undefined, T>),
    name,
  };

  // Store tool definition for later use
  toolDefinitions[name] = fullTool;

  // Add to server if enabled
  if (enabled) {
    getServer().addTool(fullTool);
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
 * Disables a tool by name.
 * @param name - The name of the tool to disable.
 * @throws - If the tool does not exist.
 * @example
 * ```ts
 * disableTool("my_tool");
 * ```
 */
export function disableTool(name: string) {
  if (!tools[name]) {
    throw new Error(`Tool with name "${name}" does not exist.`);
  }

  tools[name].enabled = false;
  // Note: The server will need to be rebuilt to reflect this change
}

/**
 * Enables a tool by name.
 * @param name - The name of the tool to enable.
 * @throws - If the tool does not exist.
 * @example
 * ```ts
 * enableTool("my_tool");
 * ```
 */
export function enableTool(name: string) {
  if (!tools[name]) {
    throw new Error(`Tool with name "${name}" does not exist.`);
  }

  tools[name].enabled = true;
  // Note: The server will need to be rebuilt to reflect this change
}

/**
 * Creates a new MCP prompt and adds it to the server.
 * @param name - The name of the prompt.
 * @param prompt - The prompt to add.
 * @param prompt.description - The description of the prompt.
 * @param prompt.arguments - The arguments for the prompt.
 * @param enabled - Whether the prompt is enabled.
 * @param status - The status of the prompt.
 * @returns - The created prompt.
 * @throws - If a prompt with the same name already exists.
 */
export function createPrompt(
  suffix: string,
  prompt: Omit<Prompt<Record<string, unknown> | undefined>, "name">,
  status: IMCPPrompt["status"] = "stable",
  enabled: boolean = true
) {
  const name = `${TOOL_PREFIX}_${suffix}`;

  if (prompts[name]) {
    throw new Error(`Prompt with name "${name}" already exists.`);
  }

  getServer().addPrompt({
    ...prompt,
    name,
  });

  return {
    name,
    arguments: prompt.arguments,
    description: prompt.description,
    enabled,
    status,
  };
}
