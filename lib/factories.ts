import type { Tool, ToolParameters, Prompt, PromptArgument } from "fastmcp";
import type { IMCPTool, IMCPPrompt } from "@/types";
import { server } from "@/server";

/**
 * User-visible list of tool details.
 */
export const tools: Record<
  string,
  IMCPTool
> = {};

/**
 * User-visible list of prompt details.
 */
export const prompts: Record<
  string,
  IMCPPrompt
> = {};

/**
 * Creates a new MCP tool and adds it to the server.
 * @param name - The name of the tool.
 * @param tool - The tool to add.
 * @param tool.description - The description of the tool.
 * @param tool.annotations - Annotations for the tool.
 * @param tool.parameters - The parameters for the tool.
 * @param tool.execute - The function to execute when the tool is called.
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
    name: string,
    tool: Omit<Tool<undefined, T>, "name">,
    enabled = true
) {
  if (tools[name]) {
    throw new Error(`Tool with name "${name}" already exists.`);
  }

  server.addTool({
    name,
    ...tool
  });

  tools[name] = {
    name,
    description: tool.annotations?.title ?? tool.description ?? `${name} tool`,
    enabled
  };

  return tools[name];
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
}

/**
 * Creates a new MCP prompt and adds it to the server.
 * @param name - The name of the prompt.
 * @param prompt - The prompt to add.
 * @param prompt.description - The description of the prompt.
 * @param prompt.arguments - The arguments for the prompt.
 * @param enabled - Whether the prompt is enabled.
 * @returns - The created prompt.
 * @throws - If a prompt with the same name already exists.
 */
export function createPrompt(
  name: string,
  prompt:  Omit<Prompt<PromptArgument[]>, "name">,
  enabled = true
) {
  server.addPrompt({
    name,
    ...prompt
  });

  return {
    name,
    arguments: prompt.arguments,
    description: prompt.description,
    enabled,
  };
}
