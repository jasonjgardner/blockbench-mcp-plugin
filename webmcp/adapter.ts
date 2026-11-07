/// <reference types="blockbench-types" />
/// <reference types="webmcp-types" />

import { zodToJsonSchema } from "zod-to-json-schema";
import type { IToolContext, IToolSpec, ToolResult } from "@/lib/factories";
import {
  sanitizeWebMcpAnnotations,
  WebMcpActionableError,
  WEBMCP_MAX_NAME_LENGTH,
  WEBMCP_MAX_PARAM_DESCRIPTION_LENGTH,
  WEBMCP_MAX_TOOL_DESCRIPTION_LENGTH,
  type IWebMcpInputSchema,
  type IWebMcpSchemaProperty,
  type IWebMcpToolDefinition,
} from "@/webmcp/runtime";

/**
 * Input shape representing an existing Blockbench MCP tool (`IToolSpec` + `execute` callback)
 * that can be bridged to WebMCP (`document.modelContext.registerTool`).
 */
export interface IAdaptableMcpTool extends IToolSpec {
  /** Original MCP execute callback from `server/tools/*` or `lib/plugin-api.ts`. */
  execute: (args: Record<string, unknown>, context?: IToolContext) => Promise<ToolResult>;
  /** Opt in when the tool output includes user-authored or external text (names, labels, file contents). */
  untrustedContentHint?: boolean;
  /**
   * Opt in only for significant, irreversible actions. MCP's `destructiveHint` is deliberately
   * not mapped: Blockbench edits are undoable, so flagging them would prompt the user on every step.
   */
  consequentialHint?: boolean;
}

/** JSON Schema node as emitted by `zod-to-json-schema`; only the keys the adapter reads are typed. */
interface IRawJsonSchemaNode {
  type?: string | readonly string[];
  description?: string;
  enum?: readonly unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: IRawJsonSchemaNode | readonly IRawJsonSchemaNode[];
  properties?: Record<string, IRawJsonSchemaNode>;
  required?: readonly string[];
  anyOf?: readonly IRawJsonSchemaNode[];
  oneOf?: readonly IRawJsonSchemaNode[];
}

const WEBMCP_SCHEMA_TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;

/**
 * Truncates a string to `maxLength` characters, appending an ellipsis when shortened.
 */
function clampText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Turns `cube_id` into `cube id` so a description no longer repeats the literal parameter name. */
function humanizeParameterName(name: string): string {
  return name.replace(/_/g, " ");
}

/**
 * Normalizes a tool description so it satisfies WebMCP's 500-char budget,
 * rewrites parameter names repeated from `inputSchema` into plain words, and guarantees
 * a "What + When" ("Use when ...") clause.
 */
export function normalizeLegacyDescription(
  description: string,
  propertyNames: readonly string[],
): string {
  const withoutBackticks = description.replace(/`([^`]+)`/g, "$1");
  const humanized = propertyNames
    .filter(prop => prop.includes("_"))
    .reduce(
      (text, prop) => text.replace(new RegExp(`\\b${prop}\\b`, "gi"), humanizeParameterName(prop)),
      withoutBackticks,
    );
  const cleaned = humanized.replace(/\s+/g, " ").trim();
  if (/\bUse when\b/i.test(cleaned)) return clampText(cleaned, WEBMCP_MAX_TOOL_DESCRIPTION_LENGTH);
  const suffix = " Use when performing this Blockbench operation.";
  return `${clampText(cleaned, WEBMCP_MAX_TOOL_DESCRIPTION_LENGTH - suffix.length)}${suffix}`;
}

/** Resolves the WebMCP primitive type of a JSON Schema node, unwrapping nullable unions. */
function resolveSchemaType(node: IRawJsonSchemaNode): IWebMcpSchemaProperty["type"] {
  const candidates: readonly string[] = Array.isArray(node.type)
    ? node.type
    : typeof node.type === "string"
      ? [node.type]
      : [];
  const direct = candidates.find(
    (candidate): candidate is IWebMcpSchemaProperty["type"] =>
      (WEBMCP_SCHEMA_TYPES as readonly string[]).includes(candidate),
  );
  if (direct) return direct;
  const union = node.anyOf ?? node.oneOf;
  const member = union?.find(entry => entry.type !== "null");
  if (member) return resolveSchemaType(member);
  if (node.properties) return "object";
  if (node.items) return "array";
  if (node.enum?.every(value => typeof value === "number")) return "number";
  return "string";
}

/** Picks the schema node that describes a value: the node itself, or the first non-null union member. */
function unwrapUnion(node: IRawJsonSchemaNode): IRawJsonSchemaNode {
  const union = node.anyOf ?? node.oneOf;
  const member = union?.find(entry => entry.type !== "null");
  return member ? { ...member, description: node.description ?? member.description } : node;
}

/**
 * Converts one JSON Schema node into a WebMCP property descriptor, recursing through
 * `properties` and `items` so batch parameters keep their element shape.
 */
function toWebMcpProperty(rawNode: IRawJsonSchemaNode, fallbackName: string): IWebMcpSchemaProperty {
  const node = unwrapUnion(rawNode);
  const type = resolveSchemaType(node);
  const rawDescription = typeof node.description === "string" && node.description.trim().length > 0
    ? node.description
    : `Parameter ${humanizeParameterName(fallbackName)}`;
  const enumValues = Array.isArray(node.enum)
    ? node.enum.map(String)
    : node.const !== undefined
      ? [String(node.const)]
      : undefined;
  const itemsNode = Array.isArray(node.items) ? node.items[0] : node.items;
  const nested = node.properties ? convertProperties(node.properties) : undefined;
  const requiredNested = Array.isArray(node.required) ? node.required.map(toSafeKey) : undefined;

  return {
    type,
    description: clampText(rawDescription, WEBMCP_MAX_PARAM_DESCRIPTION_LENGTH),
    ...(enumValues ? { enum: enumValues } : {}),
    ...(typeof node.minimum === "number" ? { minimum: node.minimum } : {}),
    ...(typeof node.maximum === "number" ? { maximum: node.maximum } : {}),
    ...(typeof node.minItems === "number" ? { minItems: node.minItems } : {}),
    ...(typeof node.maxItems === "number" ? { maxItems: node.maxItems } : {}),
    ...(type === "array" && itemsNode ? { items: toWebMcpProperty(itemsNode, `${fallbackName} item`) } : {}),
    ...(nested ? { properties: nested } : {}),
    ...(requiredNested && requiredNested.length > 0 ? { required: requiredNested } : {}),
  };
}

/** Enforces the 30-character property name budget. */
function toSafeKey(key: string): string {
  return key.slice(0, WEBMCP_MAX_NAME_LENGTH);
}

/** Converts a JSON Schema `properties` map into WebMCP property descriptors. */
function convertProperties(properties: Record<string, IRawJsonSchemaNode>): Record<string, IWebMcpSchemaProperty> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, node]) => [toSafeKey(key), toWebMcpProperty(node, key)]),
  );
}

/**
 * Converts a Zod parameter schema into a WebMCP-compliant JSON Schema (`IWebMcpInputSchema`),
 * enforcing the 30-char property name and 150-char property description budgets while
 * preserving nested object properties, array item shapes, enums, and numeric bounds.
 */
export function zodSchemaToWebMcpInputSchema(schema: IToolSpec["parameters"]): IWebMcpInputSchema {
  const raw = zodToJsonSchema(schema, { $refStrategy: "none" }) as IRawJsonSchemaNode;
  const properties = convertProperties(raw.properties ?? {});
  const required = Array.isArray(raw.required) ? raw.required.map(toSafeKey) : [];
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** Collects the text of an MCP result's `text` content blocks. */
function collectTextBlocks(result: Exclude<ToolResult, string>): string[] {
  return (result.content ?? [])
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map(block => block.text);
}

/** Parses JSON text when possible, otherwise returns the text unchanged. */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Unwraps a successful MCP SDK `ToolResult` (`string | CallToolResult`) into a concise,
 * JSON-serializable payload suitable for `document.modelContext`. Non-text content blocks
 * (images, resources) cannot travel over WebMCP and are reported as a count instead.
 */
export function unwrapMcpToolResult(result: ToolResult): unknown {
  if (typeof result === "string") return parseJsonText(result);
  if (result.structuredContent !== undefined) return result.structuredContent;
  const textBlocks = collectTextBlocks(result);
  const omitted = (result.content ?? []).length - textBlocks.length;
  const text = textBlocks.length === 1 ? parseJsonText(textBlocks[0]) : textBlocks.join("\n");
  if (omitted === 0) return textBlocks.length === 0 ? { status: "ok" } : text;
  return {
    ...(textBlocks.length > 0 ? { text } : {}),
    omitted_blocks: omitted,
    note: "Non-text content (images, resources) is not available over WebMCP.",
  };
}

/**
 * Adapts an existing Blockbench MCP `IToolSpec` + `execute` implementation into an
 * `IWebMcpToolDefinition` ready for `document.modelContext.registerTool`.
 *
 * Validates inputs with the original Zod schema (invalid arguments resolve as an
 * `INVALID_ARGUMENTS` payload), maps MCP `isError` results to `TOOL_ERROR` payloads,
 * forwards the WebMCP execution `AbortSignal` to `IToolContext.signal`, and emits only
 * opt-in annotations (`readOnlyHint` from the MCP spec, `consequentialHint` and
 * `untrustedContentHint` from the explicit adapter fields).
 *
 * @param spec - Existing MCP tool spec and execution function.
 * @returns WebMCP tool definition.
 */
export function adaptMcpToolToWebMcp(spec: IAdaptableMcpTool): IWebMcpToolDefinition {
  const safeName = toSafeKey(spec.name);
  const inputSchema = zodSchemaToWebMcpInputSchema(spec.parameters);
  const propNames = Object.keys(inputSchema.properties);
  const description = normalizeLegacyDescription(spec.description, propNames);

  const annotations = sanitizeWebMcpAnnotations({
    readOnlyHint: spec.annotations?.readOnlyHint === true ? true : undefined,
    consequentialHint: spec.consequentialHint === true ? true : undefined,
    untrustedContentHint: spec.untrustedContentHint === true ? true : undefined,
  });

  return {
    name: safeName,
    ...(spec.annotations?.title ? { title: spec.annotations.title } : {}),
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
    condition: spec.condition,
    async execute(args: Record<string, unknown>, options: WebMCP.ToolExecuteCallbackOptions): Promise<unknown> {
      const parsed = spec.parameters.safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 5)
          .map(issue => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
          .join("; ");
        throw new WebMcpActionableError(
          `Invalid arguments for ${safeName}: ${issues}`,
          "INVALID_ARGUMENTS",
          true,
          "Correct the listed parameters to match the tool's input schema and call the tool again.",
        );
      }
      const context: IToolContext = {
        reportProgress: () => {},
        sessionId: "webmcp",
        signal: options?.signal,
      };
      const result = await spec.execute(parsed.data as Record<string, unknown>, context);
      if (typeof result !== "string" && result.isError === true) {
        const message = collectTextBlocks(result).join("\n") || `${safeName} reported an error.`;
        throw new WebMcpActionableError(message, "TOOL_ERROR", true);
      }
      return unwrapMcpToolResult(result);
    },
  };
}
