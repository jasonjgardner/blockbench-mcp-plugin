import { z } from "zod";
import type { IMCPTool, IMCPPrompt, IMCPResource, StatusType } from "@/types";
import { getServer } from "@/server/server";
import { ResourceTemplate, type McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolCondition } from "@/server/tool-conditions";
import { withResourceErrors } from "@/lib/resourceErrors";
import { resolveAgentName, trackToolWrites } from "@/lib/ai-disclosure";

/**
 * MCP tool annotations advertised to clients. Hints are advisory metadata that
 * let agents decide whether a call is safe to retry (`idempotentHint`), needs
 * confirmation (`destructiveHint`), or only reads state (`readOnlyHint`).
 */
export interface IToolAnnotations {
  title?: string;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  readOnlyHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Declarative tool spec for documentation and registration.
 * Contains everything except the `execute` implementation.
 */
export interface IToolSpec {
  name: string;
  description: string;
  annotations?: IToolAnnotations;
  parameters: z.ZodType;
  status: StatusType;
  /** Native Blockbench condition, evaluated at runtime rather than during docs generation. */
  condition?: ToolCondition;
}

/**
 * Declarative prompt spec for documentation and registration.
 */
export interface IPromptSpec {
  name: string;
  description: string;
  title?: string;
  argsSchema?: z.ZodObject<z.ZodRawShape>;
  status: StatusType;
}

/**
 * Declarative resource spec for documentation and registration.
 */
export interface IResourceSpec {
  name: string;
  description: string;
  uriTemplate: string;
  title?: string;
}

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

/**
 * Per-call context passed to tool `execute()` implementations. Long-running
 * tools call `reportProgress` so MCP clients can render progress notifications.
 */
export interface IToolContext {
  reportProgress: (progress: { progress: number; total: number }) => void;
  /** MCP session issuing the call; resolves the client name credited by AI usage disclosure. */
  sessionId?: string;
}

/** Plain text convenience result or a complete SDK result, including resource content and errors. */
export type ToolResult = string | CallToolResult;

interface IToolDefinition {
  title: string;
  description: string;
  /** Raw fields used to build the plugin's tool test form. */
  inputSchema: Record<string, z.ZodType>;
  /** Complete schema used by the SDK to validate and parse incoming calls. */
  parameterSchema: z.ZodType;
  outputSchema?: Record<string, z.ZodType> | z.ZodType;
  execute: (args: Record<string, unknown>, context?: IToolContext) => Promise<ToolResult>;
  annotations?: IToolAnnotations;
  /** Explicit registration preference; conditions cannot enable a manually disabled tool. */
  configuredEnabled: boolean;
  condition?: ToolCondition;
  /** Owning plugin id for tools contributed through the plugin API (`lib/plugin-api.ts`). */
  plugin?: string;
}

/**
 * Store tool definitions for dynamic server reconstruction
 */
const toolDefinitions: Record<string, IToolDefinition> = {};

/** DOM event dispatched after a tool joins or leaves the registry, so the panel re-reads `tools`. */
export const TOOL_REGISTRY_CHANGED = "mcp:tool-registry-changed";

function notifyToolRegistryChanged(): void {
  if (typeof document === "undefined") return;
  document.dispatchEvent(new CustomEvent(TOOL_REGISTRY_CHANGED));
}

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
 * Keeps the full parser while making refined object schemas discoverable by the SDK.
 * SDK 1.x requires a public `shape` to publish an input JSON Schema for Zod 3
 * effects. Add it to a clone so refinements, transforms, and unknown-key handling
 * still run exactly once through the SDK's normal validation path.
 */
function createInputSchema(schema: z.ZodType): z.ZodType {
  const def = schema._def as { typeName?: string };
  if (def.typeName !== "ZodEffects") return schema;

  return Object.assign(schema.describe(schema.description ?? ""), {
    shape: extractShape(schema),
  });
}

/**
 * Creates a new MCP tool and registers it with the server using the official SDK.
 * @param name - The tool name suffix (will be prefixed with "blockbench_").
 * @param tool - The tool configuration.
 * @param tool.description - The description of the tool.
 * @param tool.annotations - Annotations for the tool (title, hints).
 * @param tool.parameters - Zod schema for input parameters (supports ZodObject or ZodEffects from .refine()).
 * @param tool.execute - The async function to execute when the tool is called.
 * @param tool.condition - Native Blockbench availability condition, rechecked before every execution.
 * @param tool.plugin - Owning plugin id when another plugin contributes the tool.
 * @param status - The status of the tool (stable, experimental, deprecated).
 * @param enabled - Whether the tool is enabled.
 * @returns - The created tool metadata.
 * @throws - If a tool with the same name already exists.
 */
export function createTool<T extends z.ZodType>(
  name: string,
  tool: {
    description: string;
    annotations?: IToolAnnotations;
    parameters: T;
    condition?: ToolCondition;
    plugin?: string;
    execute: (args: z.infer<T>, context?: IToolContext) => Promise<ToolResult>;
  },
  status: IMCPTool["status"] = "stable",
  enabled: boolean = true
): IMCPTool {
  if (tools[name]) throw new Error(`Tool with name "${name}" already exists.`);

  const toolDef: IToolDefinition = {
    title: tool.annotations?.title ?? tool.description,
    description: tool.description,
    inputSchema: extractShape(tool.parameters),
    parameterSchema: createInputSchema(tool.parameters),
    annotations: tool.annotations,
    configuredEnabled: enabled,
    condition: tool.condition,
    plugin: tool.plugin,
    execute: async (args, context) => {
      if (!isToolAvailable(name)) {
        throw new Error(`Tool "${name}" is unavailable in the current Blockbench project, format, mode, or selection. Refresh tools/list before retrying.`);
      }
      try {
        // Calls from MCP sessions stamp the project they write to (see lib/ai-disclosure);
        // the plugin panel's own test dialog passes no session and is not AI usage.
        const run = () => tool.execute(args, context);
        if (!context?.sessionId) return await run();
        return await trackToolWrites(resolveAgentName(context.sessionId), run);
      } finally {
        refreshToolAvailability();
      }
    },
  };
  toolDefinitions[name] = toolDef;
  tools[name] = {
    name,
    description: toolDef.title,
    enabled: isToolAvailable(name),
    status,
    plugin: tool.plugin,
  };
  registerToolOnAllServers(name, toolDef);
  notifyToolRegistryChanged();
  return tools[name];
}

/** Each SDK handle must remain registered so a later state change can re-enable it. */
const serverTools = new Map<McpServer, Map<string, RegisteredTool>>();
const schemaPublishingServers = new WeakSet<McpServer>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Produces the constrained JSON Schema subset accepted by GitHub Copilot.
 * Runtime tool calls continue through the full Zod parser, so tuple constraints
 * and unconstrained value types remain enforced by the server.
 */
function normalizePublishedSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePublishedSchema);
  if (!isRecord(value)) return value;

  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizePublishedSchema(child)]),
  );
  const ref = normalized.$ref;
  const { additionalItems, definitions, ...unmappedSchema } = normalized;
  const schema: Record<string, unknown> = {
    ...unmappedSchema,
    ...(typeof ref === "string" && ref.startsWith("#/definitions/") && {
      $ref: ref.replace("#/definitions/", "#/$defs/"),
    }),
  };
  const migratedDefinitions = isRecord(definitions) ? { $defs: definitions } : {};
  const items = schema.items;
  if (Array.isArray(items)) {
    const { items: _items, ...tupleSchema } = schema;
    if (items.length === 0) {
      return {
        ...tupleSchema,
        ...migratedDefinitions,
        ...(additionalItems !== undefined && { items: additionalItems }),
      };
    }
    return {
      ...tupleSchema,
      prefixItems: items,
      ...migratedDefinitions,
      ...(additionalItems !== undefined && { items: additionalItems }),
    };
  }
  if (isRecord(schema.additionalProperties) && Object.keys(schema.additionalProperties).length === 0) {
    return {
      ...schema,
      ...migratedDefinitions,
      additionalProperties: true,
    };
  }
  return {
    ...schema,
    ...migratedDefinitions,
  };
}

function publishedInputSchema(schema: z.ZodType): Record<string, unknown> {
  // @ts-ignore zod-to-json-schema's recursive generic type is too deep for the full tool catalog.
  const jsonSchema = zodToJsonSchema(schema, {
    $refStrategy: "none",
    pipeStrategy: "input",
    strictUnions: true,
    target: "jsonSchema2019-09",
  });
  return {
    ...normalizePublishedSchema(jsonSchema) as Record<string, unknown>,
    $schema: "https://json-schema.org/draft/2020-12/schema",
  };
}

function installSchemaPublishingHandler(server: McpServer): void {
  if (schemaPublishingServers.has(server)) return;
  schemaPublishingServers.add(server);
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(toolDefinitions)
      .filter(([name]) => isToolAvailable(name))
      .map(([name, definition]) => ({
        name,
        title: definition.title,
        description: definition.description,
        inputSchema: publishedInputSchema(definition.parameterSchema),
        annotations: definition.annotations,
        execution: { taskSupport: "forbidden" as const },
      })),
  }));
}

/**
 * Resolve the configured preference and native Blockbench condition against the
 * current editor state. A failing condition is unavailable during transient
 * project teardown; no tool implementation runs merely to discover availability.
 */
export function isToolAvailable(name: string): boolean {
  const definition = toolDefinitions[name];
  if (!definition?.configuredEnabled) return false;
  if (definition.condition === undefined) return true;
  try {
    return Condition(definition.condition);
  } catch {
    return false;
  }
}

/**
 * Re-evaluate native conditions and update the SDK handles of every connected
 * session. SDK notifications are debounced per server and only emitted when an
 * effective enabled state changes. UI metadata reflects that same state.
 */
export function refreshToolAvailability(): void {
  Object.keys(toolDefinitions).forEach(name => {
    const enabled = isToolAvailable(name);
    if (tools[name]) tools[name].enabled = enabled;
    serverTools.forEach(registrations => {
      const registration = registrations.get(name);
      if (!registration || registration.enabled === enabled) return;
      if (enabled) {
        registration.enable();
        return;
      }
      registration.disable();
    });
  });
}

function registerToolOnServer(server: McpServer, name: string, definition: IToolDefinition): void {
  let registrations = serverTools.get(server);
  if (!registrations) {
    registrations = new Map();
    serverTools.set(server, registrations);
    const onclose = server.server.onclose;
    server.server.onclose = () => {
      serverTools.delete(server);
      onclose?.();
    };
  }
  if (registrations.has(name)) return;

  // SDK 1.x accepts full Zod 3 effects at runtime but its overload infers only
  // object schemas. Keep the complete parser and narrow this one boundary.
  const register = server.registerTool.bind(server) as unknown as (
    toolName: string,
    config: { title: string; description: string; inputSchema: z.ZodType; annotations?: IToolAnnotations },
    callback: (args: Record<string, unknown>, extra?: { sessionId?: string }) => Promise<CallToolResult>
  ) => RegisteredTool;
  const registration = register(name, {
    title: definition.title,
    description: definition.description,
    inputSchema: definition.parameterSchema,
    annotations: definition.annotations,
  }, async (args, extra) => {
    const result = await definition.execute(args, { reportProgress: () => {}, sessionId: extra?.sessionId });
    if (typeof result === "string") return { content: [{ type: "text", text: result }] };
    return result;
  });
  registrations.set(name, registration);
  installSchemaPublishingHandler(server);
  if (!isToolAvailable(name)) registration.disable();
}

/**
 * Registers on the reference server and every live session server, so a tool
 * added after clients connected (for example by another plugin) reaches them.
 * The SDK notifies connected sessions itself; disconnected ones are skipped.
 */
function registerToolOnAllServers(name: string, definition: IToolDefinition): void {
  registerToolOnServer(getServer(), name, definition);
  serverTools.forEach((_registrations, server) => registerToolOnServer(server, name, definition));
}

/**
 * Removes a tool from the registry, the panel, and every session server.
 * Connected clients receive a list-changed notification from the SDK.
 *
 * @param name - Registered tool name.
 * @returns `false` when no such tool exists.
 */
export function removeTool(name: string): boolean {
  if (!toolDefinitions[name]) return false;
  serverTools.forEach(registrations => {
    registrations.get(name)?.remove();
    registrations.delete(name);
  });
  delete toolDefinitions[name];
  delete tools[name];
  notifyToolRegistryChanged();
  return true;
}

/** Returns all stored schemas and guarded implementations for the plugin's test UI. */
export function getAllToolDefinitions(): Record<string, IToolDefinition> {
  return toolDefinitions;
}

/** Returns definitions whose registration preference and native condition currently pass. */
export function getEnabledToolDefinitions(): Record<string, IToolDefinition> {
  return Object.fromEntries(Object.entries(toolDefinitions).filter(([name]) => isToolAvailable(name)));
}

/** Registers every definition, including disabled handles, so sessions track future editor changes. */
export function registerToolsOnServer(server: McpServer): void {
  Object.entries(toolDefinitions).forEach(([name, definition]) => registerToolOnServer(server, name, definition));
}

/**
 * Resource definition storage for dynamic server reconstruction
 */
interface IResourceDefinition {
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

const resourceDefinitions: Record<string, IResourceDefinition> = {};
const resourceServers = new Set<McpServer>();

function trackResourceServer(server: McpServer): void {
  if (resourceServers.has(server)) return;
  resourceServers.add(server);
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    resourceServers.delete(server);
    onclose?.();
  };
}

/** Notify every live session after the discoverable resource metadata changes. */
export function notifyResourceListChanged(): void {
  resourceServers.forEach(server => server.sendResourceListChanged());
}

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

  const resourceDef: IResourceDefinition = {
    name,
    uriTemplate: config.uriTemplate,
    metadata: {
      title: config.title,
      description: config.description,
    },
    listCallback: config.listCallback
      ? () => withResourceErrors(() => config.listCallback!())
      : undefined,
    readCallback: (uri, variables) => withResourceErrors(() => config.readCallback(uri, variables), uri),
  };

  // Store resource definition for session reconstruction
  resourceDefinitions[name] = resourceDef;

  // Register with the current server instance
  // Use ResourceTemplate to enable dynamic resource listing via listCallback
  const server = getServer();
  trackResourceServer(server);

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
    new ResourceTemplate(config.uriTemplate, { list: resourceDef.listCallback }),
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

      return resourceDef.readCallback(uri, normalizedVariables);
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
export function registerResourcesOnServer(server: McpServer) {
  trackResourceServer(server);
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
interface IPromptDefinition {
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

const promptDefinitions: Record<string, IPromptDefinition> = {};

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
    const promptDef: IPromptDefinition = {
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
