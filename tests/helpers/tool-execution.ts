/**
 * Execute tools registered through the real `lib/factories.ts` registry.
 *
 * Tests that call `registerXTools()` directly reach tools through
 * `getAllToolDefinitions()`. They repeated three patterns: parse-then-execute,
 * "the result must be text", and "the result must be structured content whose JSON
 * text mirrors `structuredContent`". These helpers implement each once, validate
 * input through the registered `parameterSchema` exactly like the MCP SDK does,
 * and narrow `unknown` results without casts.
 *
 * For tools loaded with `loadToolDefinitions()` (bundle fixtures) use
 * `IToolFixture.call` instead; those tools are not in this registry.
 *
 * @module
 */

import { getAllToolDefinitions } from "@/lib/factories";
import { isRecord } from "./assertions";
import type { ISchemaParser } from "./shapes";

/** The part of a registered tool definition these helpers use. */
export interface IRegisteredTool {
  /** The complete schema the SDK validates calls with (refinements and defaults included). */
  readonly parameterSchema: ISchemaParser;
  /** The tool implementation, called with parsed arguments. */
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** Tool definitions keyed by name; `getAllToolDefinitions()` satisfies this shape. */
export type ToolRegistry = Readonly<Record<string, IRegisteredTool | undefined>>;

/** Runtime check proving a structured result has the shape a test expects. */
export type ShapeGuard<T> = (value: unknown) => value is T;

interface ITextContent {
  readonly type: "text";
  readonly text: string;
}

/**
 * Parses raw input with a registered tool's `parameterSchema`, then executes the tool.
 *
 * Pass unparsed arguments: parsing happens here once, so schema defaults and
 * refinements behave as they do for MCP clients.
 *
 * @param name - Registered tool name, e.g. `"place_mesh"`.
 * @param input - Raw tool arguments. Defaults to `{}`.
 * @param registry - Registry to read; defaults to the live `getAllToolDefinitions()`.
 * @returns Whatever the tool resolves to (a string or `{ content, structuredContent? }`).
 * @throws {Error} When the tool is not registered; rejects with the schema's `ZodError` on invalid input.
 * @throws {TypeError} When the schema parses to a non-object, which `execute` cannot accept.
 */
export async function executeTool(name: string, input: unknown = {}, registry: ToolRegistry = getAllToolDefinitions()): Promise<unknown> {
  const tool = registry[name];
  if (!Object.hasOwn(registry, name) || !tool) {
    throw new Error(`Tool "${name}" is not registered. Call its register function (for example in beforeAll) first.`);
  }
  const parsed = await tool.parameterSchema.parseAsync(input);
  if (!isRecord(parsed)) throw new TypeError(`Tool "${name}" parameters parsed to ${describeValue(parsed)}; execute expects an object.`);
  return tool.execute(parsed);
}

/**
 * Executes a tool that must answer with plain text.
 *
 * @param name - Registered tool name.
 * @param input - Raw tool arguments. Defaults to `{}`.
 * @param registry - Registry to read; defaults to `getAllToolDefinitions()`.
 * @returns The text result.
 * @throws {TypeError} When the tool returns anything other than a string.
 */
export async function executeText(name: string, input: unknown = {}, registry: ToolRegistry = getAllToolDefinitions()): Promise<string> {
  const result = await executeTool(name, input, registry);
  if (typeof result !== "string") throw new TypeError(`Expected tool "${name}" to return text, but it returned ${describeValue(result)}.`);
  return result;
}

/**
 * Executes a tool that must answer with `structuredContent` plus an equivalent JSON text item.
 *
 * Verifies the public result contract that MCP clients rely on — a JSON text
 * item deep-equal to `structuredContent`, which also proves it is serializable —
 * then narrows `structuredContent` with `isShape`.
 *
 * @example
 * const isSnapshot = (value: unknown): value is ICapabilitiesSnapshot => isRecord(value) && isRecord(value.plugin);
 * const snapshot = await executeStructured("get_capabilities", { include_tools: true }, isSnapshot);
 *
 * @param name - Registered tool name.
 * @param input - Raw tool arguments.
 * @param isShape - Guard confirming the expected structured shape.
 * @param registry - Registry to read; defaults to `getAllToolDefinitions()`.
 * @returns `structuredContent`, narrowed to `T`.
 * @throws {TypeError} When the result is text, lacks `structuredContent` or a text item, or fails `isShape`.
 * @throws {Error} When the text item is not JSON (`cause` holds the `SyntaxError`) or differs from `structuredContent`.
 */
export async function executeStructured<T>(
  name: string,
  input: unknown,
  isShape: ShapeGuard<T>,
  registry: ToolRegistry = getAllToolDefinitions(),
): Promise<T> {
  const result = await executeTool(name, input, registry);
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new TypeError(`Expected tool "${name}" to return structured content, but it returned ${describeValue(result)}.`);
  }
  const { structuredContent } = result;
  if (structuredContent === undefined) throw new TypeError(`Tool "${name}" returned content without structuredContent.`);
  const mirrored = parseJsonText(name, result.content);
  if (!Bun.deepEquals(mirrored, structuredContent)) throw new Error(`Tool "${name}" JSON text does not match its structuredContent.`);
  if (!isShape(structuredContent)) throw new TypeError(`Tool "${name}" structuredContent does not have the expected shape.`);
  return structuredContent;
}

function parseJsonText(name: string, content: readonly unknown[]): unknown {
  const text = content.find(isTextContent);
  if (!text) throw new TypeError(`Tool "${name}" returned structuredContent without a JSON text item.`);
  try {
    return JSON.parse(text.text);
  } catch (error) {
    throw new Error(`Tool "${name}" text content is not valid JSON.`, { cause: error });
  }
}

function isTextContent(item: unknown): item is ITextContent {
  return isRecord(item) && item.type === "text" && typeof item.text === "string";
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a value of type ${typeof value}`;
}
