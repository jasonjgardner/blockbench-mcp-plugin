/**
 * Tool definition helper for the headless MCP server.
 *
 * The desktop plugin's `createTool()` registers on a module-level server and
 * gates tools with Blockbench `Condition()` checks, neither of which exists
 * outside Blockbench. Headless tools instead carry a Zod shape and an `execute`
 * that receives the shared {@link IHeadlessContext}. Plain return values become
 * JSON text; thrown errors become `isError` results with the message, so agents
 * can read and correct them.
 *
 * @module
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { IDesktopOptions } from "./app/desktop";
import type { IWebAppOptions } from "./app/web-link";
import type { ModelStore } from "./document/store";
import type { BbRenderer } from "./render/bb-render";

/** Services shared by every tool call in one server. */
export interface IHeadlessContext {
  store: ModelStore;
  renderer: BbRenderer;
  /** Stamp `ai_used`/`ai_agents` on written models. */
  aiDisclosure: boolean;
  /** Directory for render output when the caller gives no path. */
  scratchDir: string;
  /** Name the connected MCP client reported during `initialize`. */
  clientName(): string;
  /** How write results link to the Blockbench web app. */
  webApp: IWebAppOptions;
  /** How to start the Blockbench desktop app. */
  desktop: IDesktopOptions;
}

/** A tool ready to register on any server. */
export interface IRegistrableTool {
  readonly name: string;
  readonly readOnly: boolean;
  register(server: McpServer, context: IHeadlessContext): void;
}

/** Declaration of one headless tool. */
export interface IHeadlessToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  parameters: S;
  /** No file is written. */
  readOnly: boolean;
  /** Deletes or overwrites user data. */
  destructive?: boolean;
  /** Reaches outside the workspace files, such as starting another program. */
  openWorld?: boolean;
  execute(args: z.infer<z.ZodObject<S>>, context: IHeadlessContext): Promise<CallToolResult | object>;
}

/** The slice of `McpServer.registerTool` this module uses. */
type RegisterTool = (
  name: string,
  config: { title: string; description: string; inputSchema: z.ZodRawShape; annotations: Record<string, unknown> },
  callback: (args: unknown) => Promise<CallToolResult>,
) => unknown;

const isCallToolResult = (value: object): value is CallToolResult => "content" in value && Array.isArray((value as { content: unknown }).content);

/** Readable text for a failed call: Zod issues by field path, otherwise the error message. */
function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
  return error instanceof Error ? error.message : String(error);
}

/** Wraps a plain value as JSON text content. */
export function jsonResult(value: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Declares a tool.
 *
 * @returns A registrable tool that validates arguments with `parameters` before calling `execute`.
 */
export function defineTool<S extends z.ZodRawShape>(spec: IHeadlessToolSpec<S>): IRegistrableTool {
  const schema = z.object(spec.parameters);
  return {
    name: spec.name,
    readOnly: spec.readOnly,
    register(server, context) {
      // The SDK's generic overloads recurse too deeply on large Zod shapes; narrow this one boundary.
      const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
      registerTool(
        spec.name,
        {
          title: spec.title,
          description: spec.description,
          inputSchema: spec.parameters,
          annotations: { title: spec.title, readOnlyHint: spec.readOnly, destructiveHint: spec.destructive ?? false, openWorldHint: spec.openWorld ?? false },
        },
        async (raw: unknown): Promise<CallToolResult> => {
          try {
            const args = schema.parse(raw);
            const result = await spec.execute(args, context);
            return isCallToolResult(result) ? result : jsonResult(result);
          } catch (error) {
            return { isError: true, content: [{ type: "text", text: errorMessage(error) }] };
          }
        },
      );
    },
  };
}

/** Shared parameter: model file path. */
export const fileParam = z.string().min(1).describe("Path to a .bbmodel file, absolute or relative to the first workspace root.");

/** Shared parameter: optimistic-concurrency guard for writes. */
export const revisionParam = z
  .string()
  .optional()
  .describe("Revision from an earlier read. The write is refused if another agent changed the file since then.");
