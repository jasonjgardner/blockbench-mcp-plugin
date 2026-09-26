/**
 * Blockbench MCP — public API for other Blockbench plugins.
 *
 * Copy this file into your plugin (for example `src/types/blockbench-mcp-api.d.ts`)
 * to get typed access to the `MCP` global that the MCP Server plugin installs.
 * Types only: nothing here runs at build time, and the MCP plugin is never
 * bundled into yours. The `z` property needs `zod` installed as a dev
 * dependency for its types (`bun add -d zod`); at runtime it is MCP's own
 * instance, so you never bundle zod either.
 *
 * Registration works whichever plugin Blockbench loads first. Push a setup entry
 * onto `MCP_QUEUE` from your `onload`; MCP drains the queue when it loads, and
 * once it is loaded each push runs immediately:
 *
 * ```ts
 * onload() {
 *   (globalThis.MCP_QUEUE ??= []).push({
 *     plugin: "my_plugin",
 *     setup(mcp) {
 *       mcp.registerTool({
 *         name: "my_plugin_greet",
 *         description: "Greets someone.",
 *         parameters: mcp.z.object({ name: mcp.z.string() }),
 *         execute: ({ name }) => `Hello, ${name}!`,
 *       });
 *     },
 *   });
 * }
 * ```
 *
 * Tools registered with a `plugin` id are removed automatically when that
 * plugin unloads. Every registration also returns a disposer for manual cleanup.
 *
 * Entries are kept: when the MCP plugin itself is reloaded, they run again, so
 * the tools of plugins that stayed loaded come back without a reload of their
 * own. An entry in the `{ plugin, setup }` form is dropped when that plugin
 * unloads; a bare function entry cannot be, so it should check that its plugin
 * is still loaded before registering.
 *
 * @module
 */
import type { z as Zod } from "zod";

/** Stability advertised to clients and shown in the MCP panel. */
export type McpToolStatus = "stable" | "experimental";

/**
 * Advisory MCP tool hints. Agents use them to decide whether a call is safe to
 * retry, needs confirmation, or only reads state.
 */
export interface IMcpToolAnnotations {
  /** Human-readable title shown by clients; defaults to the description. */
  title?: string;
  /** The tool only reads state. */
  readOnlyHint?: boolean;
  /** The tool may delete or overwrite data. */
  destructiveHint?: boolean;
  /** Repeating the call with the same arguments has no further effect. */
  idempotentHint?: boolean;
  /** The tool reaches outside Blockbench (network, filesystem). */
  openWorldHint?: boolean;
}

/**
 * Structured availability rule, evaluated by Blockbench's native `Condition`.
 * Listed fields are combined with AND; entries inside `modes` and `formats`
 * are alternatives. An unavailable tool is hidden from clients until the
 * editor state changes, without running any plugin code.
 */
export interface IMcpToolCondition {
  /** Active mode IDs accepted by the tool, such as `edit` or `animate`. */
  modes?: string[];
  /** Active format IDs accepted by the tool, such as `bedrock` or `free`. */
  formats?: string[];
  /** Every listed format feature must be enabled, such as `animation_mode`. */
  features?: string[];
  /** Selection presence checks keyed by element type, such as `{ group: true }`. */
  selected?: Record<string, boolean>;
  /** Require an open project. */
  project?: boolean;
  /** Extra runtime check evaluated after the structured rules. */
  method?: () => boolean;
}

/** `true`/`false`, a structured rule, or a plain predicate. Omit to leave the tool always available. */
export type McpToolCondition = boolean | IMcpToolCondition | (() => boolean);

/**
 * A complete MCP tool result. `content` holds standard MCP content blocks
 * (`text`, `image`, `audio` or `resource`); `structuredContent` mirrors the
 * data for clients that support it. Return a plain string instead for a
 * text-only result.
 */
export interface IMcpToolResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Per-call context. Long-running tools report progress so clients can show it. */
export interface IMcpToolContext {
  reportProgress(progress: { progress: number; total: number }): void;
  /** MCP session issuing the call, when it came from a connected client. */
  sessionId?: string;
}

/** Everything `registerTool` needs. `TSchema` types the arguments `execute` receives. */
export interface IMcpToolOptions<TSchema extends Zod.ZodTypeAny = Zod.ZodTypeAny> {
  /**
   * Unique tool name matching `^[a-zA-Z0-9_-]{1,64}$`. Names share one
   * namespace with MCP's built-in tools, so prefix yours with your plugin id.
   */
  name: string;
  /** What the tool does and when to use it, written for an AI agent. */
  description: string;
  /** Zod object schema for the arguments; build it with `MCP.z`. Defaults to no arguments. */
  parameters?: TSchema;
  annotations?: IMcpToolAnnotations;
  condition?: McpToolCondition;
  /** Defaults to `"stable"`. Experimental tools are hidden in the panel unless enabled. */
  status?: McpToolStatus;
  /**
   * Your plugin id. Tools are removed automatically when that plugin unloads.
   * Inferred when registration happens during your plugin's `onload` or from a
   * `MCP_QUEUE` entry that names its `plugin`.
   */
  plugin?: string;
  /** Runs the tool with validated arguments. May be synchronous. */
  execute(args: Zod.infer<TSchema>, context: IMcpToolContext): string | IMcpToolResult | Promise<string | IMcpToolResult>;
}

/** Options for `exposeAction`; every field is optional. */
export interface IMcpExposeActionOptions<TSchema extends Zod.ZodTypeAny = Zod.ZodTypeAny> {
  /** Tool name; defaults to the action id. */
  name?: string;
  /** Defaults to the action's description, then its name. */
  description?: string;
  /** Arguments to accept; defaults to none. Only useful together with `execute`. */
  parameters?: TSchema;
  annotations?: IMcpToolAnnotations;
  /** Combined with the action's own condition, which is always respected. */
  condition?: McpToolCondition;
  status?: McpToolStatus;
  plugin?: string;
  /**
   * Custom runner receiving the resolved `Action`. Defaults to
   * `action.trigger()`, which also re-checks the action's condition.
   */
  execute?(args: Zod.infer<TSchema>, action: Action, context: IMcpToolContext): string | IMcpToolResult | Promise<string | IMcpToolResult>;
}

/** Removes the registration it was returned for. Safe to call more than once. */
export type McpDispose = () => void;

/** A tool as listed by the MCP panel. */
export interface IMcpToolListing {
  name: string;
  description: string;
  /** Whether the tool currently passes its condition and is offered to clients. */
  enabled: boolean;
  status: McpToolStatus;
  /** Owning plugin id for tools registered through this API. */
  plugin?: string;
}

/** The object installed as `globalThis.MCP` while the MCP Server plugin is loaded. */
export interface IBlockbenchMcpApi {
  /** MCP Server plugin version. */
  readonly version: string;
  /** MCP's own zod instance, so schemas never come from a second bundled copy. */
  readonly z: typeof Zod;
  /**
   * Registers a tool with every connected MCP client and the MCP panel.
   * @throws {Error} When the name is invalid or already taken, or `parameters` is not a Zod schema.
   */
  registerTool<TSchema extends Zod.ZodTypeAny = Zod.ZodTypeAny>(options: IMcpToolOptions<TSchema>): McpDispose;
  /**
   * Publishes an existing Blockbench `Action` as a tool. The action is looked
   * up by id on every call, and the tool is unavailable while the action is
   * missing or its condition fails. Register it after creating the action.
   */
  exposeAction<TSchema extends Zod.ZodTypeAny = Zod.ZodTypeAny>(actionId: string, options?: IMcpExposeActionOptions<TSchema>): McpDispose;
  /** Removes a tool registered through this API. Built-in tools cannot be removed. */
  unregisterTool(name: string): boolean;
  /** Every registered tool, built-in and plugin-provided. */
  listTools(): IMcpToolListing[];
  /**
   * Runs `edit` inside one Blockbench undo entry, reverting on error, and
   * credits the write to the calling MCP client for AI usage disclosure.
   */
  runUndoableEdit<T>(aspects: UndoAspects, label: string, edit: () => T, finishAspects?: UndoAspects): T;
  /** Wraps a JSON-serialisable object as text plus `structuredContent`. */
  createJsonResult(result: Record<string, unknown>): IMcpToolResult;
}

/**
 * A pending registration. The object form names the owning plugin, so tools
 * registered inside `setup` are cleaned up when that plugin unloads.
 */
export type McpQueueEntry = ((api: IBlockbenchMcpApi) => void) | { plugin: string; setup(api: IBlockbenchMcpApi): void };

declare global {
  // `var` is what makes these visible as `globalThis.MCP` / `globalThis.MCP_QUEUE`;
  // `let` and `const` in a global block do not become globalThis properties.
  /** The API while the MCP Server plugin is loaded; `undefined` otherwise. */
  var MCP: IBlockbenchMcpApi | undefined;
  /** Registrations waiting for MCP to load. Create it with `??= []` and push. */
  var MCP_QUEUE: McpQueueEntry[] | undefined;
}
