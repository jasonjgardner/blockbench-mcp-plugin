import { z } from "zod";
import type { IMCPTool, IMCPPrompt, IMCPResource } from "@/types";
import { getServer } from "@/server/server";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

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
 * User-visible list of resource details.
 */
export const resources: Record<string, IMCPResource> = {};

export interface ToolContext {
  reportProgress: (progress: { progress: number; total: number }) => void;
}

interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

type ToolContentItem = TextContent | ImageContent;

type ToolResult = string | { content: ToolContentItem[]; structuredContent?: unknown };

interface ToolDefinition {
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  outputSchema?: Record<string, z.ZodType> | z.ZodType;
  execute: (args: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>;
  annotations?: {
    title?: string;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * Store tool definitions for dynamic server reconstruction
 */
const toolDefinitions: Record<string, ToolDefinition> = {};

/**
 * Extracts the shape from a Zod schema, unwrapping ZodEffects if necessary.
 * Uses _def.typeName for reliable type checking across different Zod instances.
 */
function extractShape(schema: z.ZodType): Record<string, z.ZodType> {
  const def = schema._def as { typeName?: string; schema?: z.ZodType; shape?: () => Record<string, z.ZodType> };
  
  if (def.typeName === "ZodObject") {
    return def.shape?.() ?? {};
  }
  
  if (def.typeName === "ZodEffects" && def.schema) {
    return extractShape(def.schema);
  }
  
  return {};
}

/**
 * Creates a new MCP tool and registers it with the server using the official SDK.
 * @param suffix - The tool name suffix (will be prefixed with "blockbench_").
 * @param tool - The tool configuration.
 * @param tool.description - The description of the tool.
 * @param tool.annotations - Annotations for the tool (title, hints).
 * @param tool.parameters - Zod schema for input parameters (supports ZodObject or ZodEffects from .refine()).
 * @param tool.execute - The async function to execute when the tool is called.
 * @param status - The status of the tool (stable, experimental, deprecated).
 * @param enabled - Whether the tool is enabled.
 * @returns - The created tool metadata.
 * @throws - If a tool with the same name already exists.
 */
export function createTool<T extends z.ZodType>(
  suffix: string,
  tool: {
    description: string;
    annotations?: {
      title?: string;
      destructiveHint?: boolean;
      openWorldHint?: boolean;
    };
    parameters: T;
    execute: (args: z.infer<T>, context?: ToolContext) => Promise<ToolResult>;
  },
  status: IMCPTool["status"] = "stable",
  enabled: boolean = true
) {
  const name = `${TOOL_PREFIX}_${suffix}`;
  
  if (tools[name]) {
    throw new Error(`Tool with name "${name}" already exists.`);
  }

  const inputSchema = extractShape(tool.parameters);

  const toolDef: ToolDefinition = {
    title: tool.annotations?.title ?? tool.description,
    description: tool.description,
    inputSchema,
    execute: tool.execute,
    annotations: tool.annotations,
  };

  // Store tool definition
  toolDefinitions[name] = toolDef;

  // Register with server if enabled
  if (enabled) {
    getServer().registerTool(
      name,
      {
        title: toolDef.title,
        description: toolDef.description,
        inputSchema,
      },
      async (args: z.infer<typeof tool.parameters>, extra) => {
        // Provide a no-op reportProgress function
        // Note: Progress notifications require SSE streaming which is not enabled
        // in the current StreamableHTTPServerTransport configuration (enableJsonResponse: true)
        const reportProgress: ToolContext["reportProgress"] = () => {};

        const context: ToolContext = { reportProgress };
        const result = await tool.execute(args, context);

        // Normalize result to MCP CallToolResult format
        // Tools may return plain strings for convenience, convert to proper format
        if (typeof result === "string") {
          return {
            content: [{ type: "text", text: result }],
          };
        }

        // If result already has content array, return as-is
        if (result && typeof result === "object" && "content" in result) {
          return result;
        }

        // Fallback: stringify any other result
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      }
    );
  }

  tools[name] = {
    name,
    description: toolDef.title,
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
 * Registers all enabled tools on a server instance
 * Used to set up new session servers with the same tools
 */
export function registerToolsOnServer(server: any) {
  const enabledDefs = getEnabledToolDefinitions();

  for (const [name, toolDef] of Object.entries(enabledDefs)) {
    server.registerTool(
      name,
      {
        title: toolDef.title,
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
      },
      async (args: any, extra: any) => {
        const reportProgress: ToolContext["reportProgress"] = () => {};
        const context: ToolContext = { reportProgress };
        const result = await toolDef.execute(args, context);

        if (typeof result === "string") {
          return {
            content: [{ type: "text", text: result }],
          };
        }

        if (result && typeof result === "object" && "content" in result) {
          return result;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      }
    );
  }
}

/**
 * Resource definition storage for dynamic server reconstruction
 */
interface ResourceDefinition {
  name: string;
  uriTemplate: string;
  metadata: {
    title?: string;
    description?: string;
  };
  listCallback?: () => Promise<{
    resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  }>;
  readCallback: (uri: URL, variables: Record<string, string>) => Promise<{
    contents: Array<{ uri: string; text?: string; blob?: string }>;
  }>;
}

const resourceDefinitions: Record<string, ResourceDefinition> = {};

/**
 * Creates a new MCP resource and registers it with the server using the official SDK.
 * @param name - The resource name.
 * @param config - The resource configuration.
 * @param config.uriTemplate - The URI template pattern (e.g., "nodes://{id}").
 * @param config.title - Optional title for the resource.
 * @param config.description - The description of the resource.
 * @param config.listCallback - Optional async function to list available resources.
 * @param config.readCallback - Async function to read the resource.
 * @returns - The created resource metadata.
 */
export function createResource(
  name: string,
  config: {
    uriTemplate: string;
    title?: string;
    description: string;
    listCallback?: () => Promise<{
      resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
    }>;
    readCallback: (uri: URL, variables: Record<string, string>) => Promise<{
      contents: Array<{ uri: string; text?: string; blob?: string }>;
    }>;
  }
) {
  if (resources[name]) {
    throw new Error(`Resource with name "${name}" already exists.`);
  }

  const resourceDef: ResourceDefinition = {
    name,
    uriTemplate: config.uriTemplate,
    metadata: {
      title: config.title,
      description: config.description,
    },
    listCallback: config.listCallback,
    readCallback: config.readCallback,
  };

  // Store resource definition for session reconstruction
  resourceDefinitions[name] = resourceDef;

  // Register with the current server instance
  getServer().registerResource(
    name,
    config.uriTemplate,
    {
      title: config.title,
      description: config.description,
    },
    async (uri, variables) => {
      return config.readCallback(uri, variables as Record<string, string>);
    }
  );

  resources[name] = {
    name,
    description: config.description,
    uriTemplate: config.uriTemplate,
  };

  return resources[name];
}

/**
 * Gets all resource definitions for server reconstruction
 */
export function getAllResourceDefinitions() {
  return resourceDefinitions;
}

/**
 * Registers all resources on a server instance
 * Used to set up new session servers with the same resources
 */
export function registerResourcesOnServer(server: any) {
  for (const [name, resourceDef] of Object.entries(resourceDefinitions)) {
    server.registerResource(
      name,
      resourceDef.uriTemplate,
      resourceDef.metadata,
      async (uri: URL, variables: Record<string, string>) => {
        return resourceDef.readCallback(uri, variables);
      }
    );
  }
}

/**
 * Creates a new MCP prompt and registers it with the server using the official SDK.
 * @param suffix - The prompt name suffix (will be prefixed with "blockbench_").
 * @param prompt - The prompt configuration.
 * @param prompt.description - The description of the prompt.
 * @param prompt.arguments - Zod schema for prompt arguments.
 * @param prompt.generate - Function to generate prompt messages from arguments.
 * @param status - The status of the prompt.
 * @param enabled - Whether the prompt is enabled.
 * @returns - The created prompt metadata.
 * @throws - If a prompt with the same name already exists.
 */
export function createPrompt<T extends z.ZodRawShape = Record<string, never>>(
  suffix: string,
  prompt: {
    title?: string;
    description: string;
    argsSchema?: z.ZodObject<T>;
    generate?: (args: z.infer<z.ZodObject<T>>) => {
      messages: Array<{
        role: "user" | "assistant";
        content: { type: string; text: string };
      }>;
    };
  },
  status: IMCPPrompt["status"] = "stable",
  enabled: boolean = true
) {
  const name = `${TOOL_PREFIX}_${suffix}`;

  if (prompts[name]) {
    throw new Error(`Prompt with name "${name}" already exists.`);
  }

  // For now, skip registration if no generate function provided (legacy prompts)
  // TODO: Refactor legacy prompts to use new API
  if (enabled && prompt.generate && prompt.argsSchema) {
    getServer().registerPrompt(
      name,
      {
        title: prompt.title || prompt.description,
        description: prompt.description,
        argsSchema: prompt.argsSchema.shape,
      },
      (args: z.infer<z.ZodObject<T>>) => {
        return prompt.generate!(args);
      }
    );
  }

  prompts[name] = {
    name,
    arguments: prompt.argsSchema?.shape || {},
    description: prompt.description,
    enabled,
    status,
  };

  return prompts[name];
}
