/// <reference types="blockbench-types" />
/**
 * Runtime behind the `MCP` global that other Blockbench plugins use to add
 * tools. The public contract lives in `lib/mcp-api.d.ts`, which authors copy
 * into their own plugin; this module must keep satisfying it.
 *
 * Load order between plugins is not guaranteed, so two entry points exist:
 * `globalThis.MCP` for plugins that load after MCP, and the `MCP_QUEUE` array
 * for plugins that load before it. Installing drains the queue and then
 * replaces its `push` so later entries run at once, and uninstalling puts a
 * plain array back so a reload queues again.
 *
 * @module
 */
import { z } from "zod";
import { VERSION } from "@/lib/constants";
import { createTool, removeTool, tools, type IToolContext, type ToolResult } from "@/lib/factories";
import { createJsonResult } from "@/lib/tool-results";
import { runUndoableEdit } from "@/lib/undo";
import type { IToolCondition, ToolCondition } from "@/server/tool-conditions";
import type {
  IBlockbenchMcpApi, IMcpExposeActionOptions, IMcpToolContext, IMcpToolListing, IMcpToolOptions, IMcpToolResult, McpDispose, McpQueueEntry, McpToolCondition,
} from "@/lib/mcp-api";

/**
 * `registerTool` as used inside this module: the public condition shape is a
 * subset of the internal one, so `exposeAction` can wrap an action's own
 * condition while public callers keep the documented type.
 */
interface IInternalToolOptions<TSchema extends z.ZodTypeAny> extends Omit<IMcpToolOptions<TSchema>, "condition"> {
  condition?: ToolCondition;
}

/** Plugin id MCP registers under; registrations made while MCP itself loads are not attributed to it. */
const MCP_PLUGIN_ID = "mcp";
/** MCP tool names, per the specification; also keeps names usable as identifiers by clients. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Tools registered through the API, so uninstalling and `unregisterTool` never touch built-in tools. */
const apiTools = new Set<string>();
/** Tool names per owning plugin id, for cleanup when that plugin unloads. */
const ownedTools = new Map<string, Set<string>>();
/** Owner applied to registrations made while running a queue entry that names its plugin. */
let queueOwner: string | undefined;
/**
 * Every queue entry adopted so far. Reloading MCP (the usual development
 * loop) must not lose tools of plugins that stay loaded, so uninstalling
 * re-queues these and the next install runs them again. An entry is dropped
 * when Blockbench unloads the plugin it names.
 */
const retainedEntries: McpQueueEntry[] = [];
let installed: IBlockbenchMcpApi | undefined;
let unloadListener: ((data: { plugin: { id: string } }) => void) | undefined;

/** The narrow host surface used here; blockbench-types leaves `BarItems` untyped. */
interface IActionHost {
  BarItems?: Record<string, unknown>;
  Plugins?: { currently_loading?: string };
  Blockbench?: {
    on(event: string, callback: (data: { plugin: { id: string } }) => void): unknown;
    removeListener(event: string, callback: (data: { plugin: { id: string } }) => void): unknown;
  };
}

const host = (): IActionHost => globalThis as unknown as IActionHost;

/** Resolves the owning plugin: explicit option, then the queue entry's plugin, then the plugin Blockbench is loading. */
function resolveOwner(explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  if (queueOwner) return queueOwner;
  const loading = host().Plugins?.currently_loading;
  return loading && loading !== MCP_PLUGIN_ID ? loading : undefined;
}

function validateName(name: unknown, owner: string | undefined): string {
  if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`MCP tool names must match ${TOOL_NAME_PATTERN}, received ${JSON.stringify(name)}.`);
  }
  if (tools[name]) {
    const prefix = owner ?? "my_plugin";
    throw new Error(`MCP tool "${name}" already exists. Prefix the name with your plugin id, for example "${prefix}_${name}".`);
  }
  return name;
}

function validateDescription(description: unknown, name: string): string {
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`MCP tool "${name}" needs a non-empty description; agents choose tools by it.`);
  }
  return description;
}

/**
 * Accepts any Zod schema, including one from a plugin's own bundled copy.
 * Instances are duck-typed because a second zod bundle fails `instanceof`.
 */
function validateParameters(parameters: unknown, name: string): z.ZodTypeAny {
  if (parameters === undefined) return z.object({});
  const candidate = parameters as { parse?: unknown; _def?: unknown; "~standard"?: unknown } | null;
  const zodLike = typeof candidate === "object" && candidate !== null && typeof candidate.parse === "function" && ("_def" in candidate || "~standard" in candidate);
  if (!zodLike) throw new TypeError(`MCP tool "${name}": parameters must be a Zod schema. Build it with MCP.z.object({ ... }) so zod is not bundled twice.`);
  return parameters as z.ZodTypeAny;
}

const toContext = (context: IToolContext | undefined): IMcpToolContext => context ?? { reportProgress: () => {} };

/** Evaluates a public condition through Blockbench's native `Condition`; unavailable when the host is missing. */
function evaluateCondition(condition: McpToolCondition): boolean {
  if (typeof Condition !== "function") return false;
  try {
    return Condition(condition);
  } catch {
    return false;
  }
}

/** The SDK validates result content when it serialises the response; this boundary only narrows the static type. */
const toToolResult = (result: string | IMcpToolResult): ToolResult => result as ToolResult;

function trackOwnership(name: string, owner: string | undefined): void {
  apiTools.add(name);
  if (!owner) return;
  const names = ownedTools.get(owner) ?? new Set<string>();
  names.add(name);
  ownedTools.set(owner, names);
}

function unregister(name: string): boolean {
  if (!apiTools.has(name)) return false;
  apiTools.delete(name);
  ownedTools.forEach(names => names.delete(name));
  return removeTool(name);
}

/** Removes every tool a plugin registered; called when Blockbench unloads that plugin. */
export function removePluginTools(pluginId: string): number {
  const names = [...(ownedTools.get(pluginId) ?? [])];
  ownedTools.delete(pluginId);
  return names.filter(unregister).length;
}

function registerTool<TSchema extends z.ZodTypeAny>(options: IInternalToolOptions<TSchema>): McpDispose {
  const owner = resolveOwner(options.plugin);
  const name = validateName(options.name, owner);
  const description = validateDescription(options.description, name);
  const parameters = validateParameters(options.parameters, name);
  if (typeof options.execute !== "function") throw new TypeError(`MCP tool "${name}" needs an execute function.`);
  const execute = options.execute;
  createTool(name, {
    description,
    annotations: { title: options.annotations?.title ?? description, ...options.annotations },
    parameters,
    condition: options.condition,
    plugin: owner,
    execute: async (args, context) => toToolResult(await execute(args as z.infer<TSchema>, toContext(context))),
  }, options.status ?? "stable");
  trackOwnership(name, owner);
  return () => void unregister(name);
}

/**
 * Looks the action up on every use, so a tool registered before its action
 * exists still works later. Duck-typed: the `Action` class is a Blockbench
 * global that does not exist where this module is unit tested.
 */
function findAction(actionId: string): Action | undefined {
  const item = host().BarItems?.[actionId] as Partial<Action> | undefined;
  return typeof item?.trigger === "function" && typeof item.conditionMet === "function" ? (item as Action) : undefined;
}

function exposeAction<TSchema extends z.ZodTypeAny>(actionId: string, options: IMcpExposeActionOptions<TSchema> = {}): McpDispose {
  if (typeof actionId !== "string" || actionId === "") throw new Error("exposeAction needs the id of a registered Blockbench Action.");
  const action = findAction(actionId);
  const description = options.description ?? action?.description ?? action?.name ?? `Triggers the Blockbench action "${actionId}".`;
  const custom = options.execute;
  const narrowing = options.condition;
  // One predicate evaluates both: native `Condition` stops at a nested
  // `condition` without reaching `method`, so nesting would drop the action check.
  const condition: IToolCondition = {
    method: () => {
      if (narrowing !== undefined && !evaluateCondition(narrowing)) return false;
      return findAction(actionId)?.conditionMet() === true;
    },
  };
  return registerTool<TSchema>({
    name: options.name ?? actionId,
    description,
    parameters: options.parameters,
    annotations: { title: options.annotations?.title ?? action?.name ?? actionId, ...options.annotations },
    condition,
    status: options.status,
    plugin: options.plugin,
    execute: (args, context) => {
      const current = findAction(actionId);
      if (!current) throw new Error(`Blockbench action "${actionId}" is not registered.`);
      if (custom) return custom(args, current, context);
      if (current.trigger() === false) throw new Error(`Blockbench action "${actionId}" is unavailable in the current editor state.`);
      return `Triggered Blockbench action "${actionId}".`;
    },
  });
}

function listTools(): IMcpToolListing[] {
  return Object.values(tools).map(tool => ({ name: tool.name, description: tool.description, enabled: tool.enabled, status: tool.status, plugin: tool.plugin }));
}

function createApi(): IBlockbenchMcpApi {
  return Object.freeze({
    version: VERSION,
    z,
    registerTool,
    exposeAction,
    unregisterTool: unregister,
    listTools,
    runUndoableEdit,
    createJsonResult,
  });
}

/** Failures inside one plugin's setup are reported and never stop the others. */
function runQueueEntry(api: IBlockbenchMcpApi, entry: McpQueueEntry): void {
  try {
    if (typeof entry === "function") {
      entry(api);
      return;
    }
    if (typeof entry?.setup !== "function") throw new TypeError("MCP_QUEUE entries are functions or { plugin, setup } objects.");
    queueOwner = typeof entry.plugin === "string" && entry.plugin !== "" ? entry.plugin : undefined;
    try {
      entry.setup(api);
    } finally {
      queueOwner = undefined;
    }
  } catch (error) {
    console.error("[MCP] A plugin's MCP setup failed:", error);
  }
}

/** Runs an entry now and keeps it, so an MCP reload can run it again. */
function adoptEntry(api: IBlockbenchMcpApi, entry: McpQueueEntry): void {
  retainedEntries.push(entry);
  runQueueEntry(api, entry);
}

/** Runs whatever queued before MCP loaded, then makes later pushes run immediately. */
function adoptQueue(api: IBlockbenchMcpApi): void {
  const pending = Array.isArray(globalThis.MCP_QUEUE) ? [...globalThis.MCP_QUEUE] : [];
  const live: McpQueueEntry[] = [];
  live.push = (...entries: McpQueueEntry[]): number => {
    entries.forEach(entry => adoptEntry(api, entry));
    return live.length;
  };
  globalThis.MCP_QUEUE = live;
  pending.forEach(entry => adoptEntry(api, entry));
}

/** Forgets the retained entries a plugin contributed, so an MCP reload does not resurrect its tools. */
function dropRetainedEntries(pluginId: string): void {
  const kept = retainedEntries.filter(entry => typeof entry === "function" || entry.plugin !== pluginId);
  retainedEntries.splice(0, retainedEntries.length, ...kept);
}

/**
 * Installs `globalThis.MCP`, drains `MCP_QUEUE`, and starts removing tools of
 * plugins as they unload. Call once from the MCP plugin's `onload`, after the
 * built-in tools are registered.
 *
 * @returns The installed API.
 */
export function installPluginApi(): IBlockbenchMcpApi {
  if (installed) return installed;
  const api = createApi();
  installed = api;
  globalThis.MCP = api;
  unloadListener = ({ plugin }) => {
    removePluginTools(plugin.id);
    dropRetainedEntries(plugin.id);
  };
  host().Blockbench?.on("unloaded_plugin", unloadListener);
  adoptQueue(api);
  return api;
}

/**
 * Removes every plugin-registered tool and the global, and puts the adopted
 * entries back on a plain `MCP_QUEUE`, so the next install (an MCP reload)
 * re-registers the tools of plugins that stayed loaded and picks up anything
 * queued meanwhile.
 */
export function uninstallPluginApi(): void {
  if (!installed) return;
  [...apiTools].forEach(unregister);
  ownedTools.clear();
  if (unloadListener) host().Blockbench?.removeListener("unloaded_plugin", unloadListener);
  unloadListener = undefined;
  installed = undefined;
  delete globalThis.MCP;
  globalThis.MCP_QUEUE = retainedEntries.splice(0, retainedEntries.length);
}

/** The installed API, for tests and the panel; `undefined` while the plugin is unloaded. */
export function getPluginApi(): IBlockbenchMcpApi | undefined {
  return installed;
}
