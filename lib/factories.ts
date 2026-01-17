import { z } from "zod";
import type { IMCPTool, IMCPPrompt, IMCPResource } from "@/types";
import { getServer } from "@/server/server";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

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
    readOnlyHint?: boolean;
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
 * @param name - The tool name suffix (will be prefixed with "blockbench_").
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
  name: string,
  tool: {
    description: string;
    annotations?: {
      title?: string;
      destructiveHint?: boolean;
      openWorldHint?: boolean;
      readOnlyHint?: boolean;
    };
    parameters: T;
    execute: (args: z.infer<T>, context?: ToolContext) => Promise<ToolResult>;
  },
  status: IMCPTool["status"] = "stable",
  enabled: boolean = true
) {
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
    type ToolArgs = z.infer<T>;

    const server = getServer();

    const registerTool = server.registerTool.bind(server) as unknown as (
      toolName: string,
      definition: {
        title: string;
        description: string;
        inputSchema: Record<string, z.ZodType>;
      },
      callback: (args: unknown, extra: unknown) => Promise<unknown>
    ) => void;

    registerTool(
      name,
      {
        title: toolDef.title,
        description: toolDef.description,
        inputSchema,
      },
      async (args: unknown, _extra: unknown) => {
        // Provide a no-op reportProgress function
        // Note: Progress notifications require SSE streaming which is not enabled
        // in the current StreamableHTTPServerTransport configuration (enableJsonResponse: true)
        const reportProgress: ToolContext["reportProgress"] = () => {};

        const context: ToolContext = { reportProgress };
        const result = await tool.execute(args as ToolArgs, context);

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
export function registerToolsOnServer(server: unknown) {
  const enabledDefs = getEnabledToolDefinitions();

  const typedServer = server as {
    registerTool: (
      toolName: string,
      definition: {
        title: string;
        description: string;
        inputSchema: Record<string, z.ZodType>;
      },
      callback: (args: unknown, extra: unknown) => Promise<unknown>
    ) => void;
  };

  for (const [name, toolDef] of Object.entries(enabledDefs)) {
    typedServer.registerTool(
      name,
      {
        title: toolDef.title,
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
      },
      async (args: unknown, _extra: unknown) => {
        const reportProgress: ToolContext["reportProgress"] = () => {};
        const context: ToolContext = { reportProgress };
        const result = await toolDef.execute(args as Record<string, unknown>, context);

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
  readCallback: (
    uri: URL,
    variables: Record<string, string>
  ) => Promise<{
    contents: Array<{ uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string }>;
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
    readCallback: (
      uri: URL,
      variables: Record<string, string>
    ) => Promise<{
      contents: Array<{ uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string }>;
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
  // Use ResourceTemplate to enable dynamic resource listing via listCallback
  const server = getServer();

  const registerResource = (
    server as unknown as {
      registerResource: (
        resourceName: string,
        uriOrTemplate: ResourceTemplate,
        metadata: {
          title?: string;
          description?: string;
        },
        readCallback: (
          uri: URL,
          variables: Record<string, string | string[]>
        ) => Promise<{
          contents: Array<{ uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string }>;
        }>
      ) => void;
    }
  ).registerResource.bind(server);

  registerResource(
    name,
    new ResourceTemplate(config.uriTemplate, { list: config.listCallback }),
    {
      title: config.title,
      description: config.description,
    },
    async (uri: URL, variables: Record<string, string | string[]>) => {
      const normalizedVariables = Object.fromEntries(
        Object.entries(variables).map(([key, value]) => {
          if (Array.isArray(value)) {
            return [key, value[0] ?? ""];
          }
          return [key, value];
        })
      ) as Record<string, string>;

      return config.readCallback(uri, normalizedVariables);
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
export function registerResourcesOnServer(server: unknown) {
  const typedServer = server as {
    registerResource: (
      resourceName: string,
      uriOrTemplate: ResourceTemplate,
      metadata: {
        title?: string;
        description?: string;
      },
      readCallback: (
        uri: URL,
        variables: Record<string, string | string[]>
      ) => Promise<{
        contents: Array<{ uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string }>;
      }>
    ) => void;
  };

  for (const [name, resourceDef] of Object.entries(resourceDefinitions)) {
    typedServer.registerResource(
      name,
      new ResourceTemplate(resourceDef.uriTemplate, { list: resourceDef.listCallback }),
      resourceDef.metadata,
      async (uri: URL, variables: Record<string, string | string[]>) => {
        const normalizedVariables = Object.fromEntries(
          Object.entries(variables).map(([key, value]) => {
            if (Array.isArray(value)) {
              return [key, value[0] ?? ""];
            }
            return [key, value];
          })
        ) as Record<string, string>;

        return resourceDef.readCallback(uri, normalizedVariables);
      }
    );
  }
}

/**
 * Prompt definition storage for dynamic server reconstruction
 */
interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  argsSchema?: Record<string, z.ZodType>;
  generate: (args: Record<string, unknown>) => Promise<{
    messages: Array<{
      role: "user" | "assistant";
      content: { type: string; text: string };
    }>;
  }>;
}

const promptDefinitions: Record<string, PromptDefinition> = {};

/**
 * Creates a new MCP prompt and registers it with the server using the official SDK.
 * @param name - The prompt name
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
  name: string,
  prompt: {
    title?: string;
    description: string;
    argsSchema?: z.ZodObject<T>;
    generate?: (
      args: z.infer<z.ZodObject<T>>
    ) =>
      | {
      messages: Array<{
        role: "user" | "assistant";
        content: { type: string; text: string };
      }>;
    }
      | Promise<{
          messages: Array<{
            role: "user" | "assistant";
            content: { type: string; text: string };
          }>;
        }>;
  },
  status: IMCPPrompt["status"] = "stable",
  enabled: boolean = true
) {
  if (prompts[name]) {
    throw new Error(`Prompt with name "${name}" already exists.`);
  }

  // Store prompt definition for session reconstruction
  if (enabled && prompt.generate && prompt.argsSchema) {
    const promptDef: PromptDefinition = {
      name,
      title: prompt.title || prompt.description,
      description: prompt.description,
      argsSchema: prompt.argsSchema.shape,
      generate: async (args: Record<string, unknown>) => {
        const result = await prompt.generate!(args as z.infer<z.ZodObject<T>>);
        return result;
      },
    };

    promptDefinitions[name] = promptDef;

    // Register with the singleton server
    getServer().registerPrompt(
      name,
      {
        title: promptDef.title,
        description: promptDef.description,
        argsSchema: promptDef.argsSchema,
      },
      promptDef.generate
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

/**
 * Gets all prompt definitions for server reconstruction
 */
export function getAllPromptDefinitions() {
  return promptDefinitions;
}

/**
 * Registers all prompts on a server instance
 * Used to set up new session servers with the same prompts
 */
export function registerPromptsOnServer(server: unknown) {
  const typedServer = server as {
    registerPrompt: (
      promptName: string,
      definition: {
        title: string;
        description: string;
        argsSchema?: Record<string, z.ZodType>;
      },
      callback: (args: Record<string, unknown>) => Promise<{
        messages: Array<{
          role: "user" | "assistant";
          content: { type: string; text: string };
        }>;
      }>
    ) => void;
  };

  for (const [name, promptDef] of Object.entries(promptDefinitions)) {
    typedServer.registerPrompt(
      name,
      {
        title: promptDef.title,
        description: promptDef.description,
        argsSchema: promptDef.argsSchema,
      },
      promptDef.generate
    );
  }
}
