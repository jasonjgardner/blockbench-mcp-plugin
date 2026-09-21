import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createTool, getAllToolDefinitions, refreshToolAvailability, registerToolsOnServer, tools, TOOL_REGISTRY_CHANGED } from "@/lib/factories";
import { getPluginApi, installPluginApi, removePluginTools, uninstallPluginApi } from "@/lib/plugin-api";
import type { IBlockbenchMcpApi, McpQueueEntry } from "@/lib/mcp-api";
import { createServer, getServer, setServer } from "@/server/server";
import { evaluateHostCondition } from "@/tests/helpers/condition-host";
import { installGlobals, type RestoreGlobals } from "@/tests/helpers/globals";
import { executeText } from "@/tests/helpers/tool-execution";

type UnloadListener = (data: { plugin: { id: string } }) => void;

/** Blockbench host double: captures the unload listener and offers a fake action registry. */
interface IHostDouble {
  unloadListeners: UnloadListener[];
  actions: Record<string, unknown>;
  restore: RestoreGlobals;
}

const originalServer = getServer();
let clients: Client[] = [];
let servers: ReturnType<typeof createServer>[] = [];
let host: IHostDouble;

function installHost(extra: Record<string, unknown> = {}): IHostDouble {
  const unloadListeners: UnloadListener[] = [];
  const actions: Record<string, unknown> = {};
  const restore = installGlobals({
    Blockbench: {
      on: (event: string, callback: UnloadListener) => {
        if (event === "unloaded_plugin") unloadListeners.push(callback);
      },
      removeListener: (_event: string, callback: UnloadListener) => {
        const index = unloadListeners.indexOf(callback);
        if (index >= 0) unloadListeners.splice(index, 1);
      },
    },
    BarItems: actions,
    Condition: evaluateHostCondition,
    Plugins: { currently_loading: "" },
    ...extra,
  });
  return { unloadListeners, actions, restore };
}

function resetRegistry(): void {
  Object.keys(tools).forEach(name => delete tools[name]);
  const definitions = getAllToolDefinitions();
  Object.keys(definitions).forEach(name => delete definitions[name]);
}

beforeEach(() => {
  resetRegistry();
  const server = createServer();
  servers = [server];
  setServer(server);
  host = installHost();
});

afterEach(async () => {
  uninstallPluginApi();
  delete globalThis.MCP_QUEUE;
  await Promise.all(clients.map(client => client.close()));
  await Promise.all(servers.map(server => server.close()));
  clients = [];
  servers = [];
  resetRegistry();
  setServer(originalServer);
  host.restore();
});

/** Connects a client either to the reference server or to a fresh per-session server. */
async function connectClient(mode: "reference" | "session"): Promise<Client> {
  const server = mode === "reference" ? getServer() : createServer();
  if (mode === "session") {
    servers.push(server);
    registerToolsOnServer(server);
  }
  const client = new Client({ name: "plugin-api-test", version: "1.0.0" });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const toolNames = async (client: Client): Promise<string[]> => (await client.listTools()).tools.map(tool => tool.name).toSorted();

function greetingTool(mcp: IBlockbenchMcpApi, name: string, plugin?: string): () => void {
  return mcp.registerTool({
    name,
    description: `Greets by ${name}.`,
    parameters: mcp.z.object({ who: mcp.z.string().default("world") }),
    plugin,
    execute: ({ who }) => `hello ${who}`,
  });
}

test("installPluginApi drains MCP_QUEUE, attributes owners from object entries, and runs later pushes at once", () => {
  const order: string[] = [];
  globalThis.MCP_QUEUE = [
    mcp => {
      order.push("function");
      greetingTool(mcp, "queued_anonymous");
    },
    {
      plugin: "acme",
      setup(mcp) {
        order.push("object");
        greetingTool(mcp, "queued_owned");
      },
    },
  ];
  const api = installPluginApi();
  expect(globalThis.MCP).toBe(api);
  expect(getPluginApi()).toBe(api);
  expect(order).toEqual(["function", "object"]);
  expect(tools.queued_anonymous?.plugin).toBeUndefined();
  expect(tools.queued_owned?.plugin).toBe("acme");

  globalThis.MCP_QUEUE?.push({ plugin: "late", setup: mcp => void greetingTool(mcp, "pushed_after_install") });
  expect(tools.pushed_after_install?.plugin).toBe("late");
  // The live queue never accumulates entries; each push runs and is forgotten.
  expect(globalThis.MCP_QUEUE).toHaveLength(0);
});

test("a failing queue entry is reported and does not stop the entries after it", () => {
  const error = mock(() => {});
  const restoreConsole = installGlobals({ console: { ...console, error } });
  try {
    globalThis.MCP_QUEUE = [
      () => {
        throw new Error("setup exploded");
      },
      mcp => void greetingTool(mcp, "survivor"),
      { plugin: "bad", setup: "not a function" } as unknown as McpQueueEntry,
    ];
    installPluginApi();
    expect(tools.survivor).toBeDefined();
    expect(error).toHaveBeenCalledTimes(2);
  } finally {
    restoreConsole();
  }
});

test("registerTool reaches the reference server and live sessions, and the disposer removes it with a notification", async () => {
  const api = installPluginApi();
  // Session servers always carry the built-in tools before they connect (server/net.ts);
  // the SDK cannot initialise tool capabilities on a connected server that has none.
  createTool("builtin", { description: "Built in.", parameters: z.object({}), execute: async () => "ok" });
  const reference = await connectClient("reference");
  const session = await connectClient("session");
  const notified = mock(() => {});
  session.setNotificationHandler(ToolListChangedNotificationSchema, notified);

  const dispose = greetingTool(api, "acme_greet", "acme");
  expect(await toolNames(reference)).toEqual(["acme_greet", "builtin"]);
  expect(await toolNames(session)).toEqual(["acme_greet", "builtin"]);
  const result = await session.callTool({ name: "acme_greet", arguments: { who: "Blockbench" } });
  expect(result.isError).not.toBe(true);
  expect(result.content).toEqual([{ type: "text", text: "hello Blockbench" }]);
  expect(tools.acme_greet).toMatchObject({ plugin: "acme", enabled: true, status: "stable" });
  expect(notified).toHaveBeenCalledTimes(1);

  dispose();
  dispose();
  expect(tools.acme_greet).toBeUndefined();
  expect(await toolNames(reference)).toEqual(["builtin"]);
  expect(await toolNames(session)).toEqual(["builtin"]);
  expect(notified).toHaveBeenCalledTimes(2);
});

test("unloading a plugin removes only the tools it owns", () => {
  const api = installPluginApi();
  greetingTool(api, "acme_one", "acme");
  greetingTool(api, "acme_two", "acme");
  greetingTool(api, "other_one", "other");
  createTool("builtin", { description: "Built in.", parameters: z.object({}), execute: async () => "ok" });
  expect(host.unloadListeners).toHaveLength(1);

  host.unloadListeners[0]?.({ plugin: { id: "acme" } });
  expect(Object.keys(tools).toSorted()).toEqual(["builtin", "other_one"]);
  expect(removePluginTools("acme")).toBe(0);
  expect(removePluginTools("other")).toBe(1);
  expect(Object.keys(tools)).toEqual(["builtin"]);
});

test("a registration made while Blockbench loads a plugin is attributed to that plugin, but never to MCP itself", () => {
  const api = installPluginApi();
  const plugins = (globalThis as unknown as { Plugins: { currently_loading: string } }).Plugins;
  plugins.currently_loading = "havok_animations";
  greetingTool(api, "havok_bake");
  plugins.currently_loading = "mcp";
  greetingTool(api, "during_mcp_load");
  plugins.currently_loading = "";
  expect(tools.havok_bake?.plugin).toBe("havok_animations");
  expect(tools.during_mcp_load?.plugin).toBeUndefined();
  expect(api.listTools().map(tool => [tool.name, tool.plugin])).toEqual([["havok_bake", "havok_animations"], ["during_mcp_load", undefined]]);
});

test("exposeAction follows the action's condition, honours a narrowing condition, and triggers the action", async () => {
  const api = installPluginApi();
  let available = false;
  const trigger = mock(() => true);
  host.actions.demo_action = { name: "Demo", description: "Runs the demo.", conditionMet: () => available, trigger };

  api.exposeAction("demo_action", { plugin: "acme" });
  // The panel entry carries the title (the action's name); the client-facing description is the action's.
  expect(tools.demo_action).toMatchObject({ description: "Demo", enabled: false, plugin: "acme" });
  expect(getAllToolDefinitions().demo_action?.description).toBe("Runs the demo.");
  available = true;
  refreshToolAvailability();
  expect(tools.demo_action?.enabled).toBe(true);
  expect(await executeText("demo_action")).toBe('Triggered Blockbench action "demo_action".');
  expect(trigger).toHaveBeenCalledTimes(1);

  trigger.mockReturnValueOnce(false);
  await expect(executeText("demo_action")).rejects.toThrow("unavailable in the current editor state");

  api.exposeAction("demo_action", { name: "demo_narrowed", condition: () => false });
  expect(tools.demo_narrowed?.enabled).toBe(false);
  api.exposeAction("demo_action", { name: "demo_widened", condition: { project: false } });
  expect(tools.demo_widened?.enabled).toBe(true);

  api.exposeAction("missing_action");
  expect(tools.missing_action).toMatchObject({ description: "missing_action", enabled: false });
  expect(getAllToolDefinitions().missing_action?.description).toBe('Triggers the Blockbench action "missing_action".');
  await expect(executeText("missing_action")).rejects.toThrow("unavailable in the current Blockbench project");
});

test("exposeAction hands a custom runner the live action and the parsed arguments", async () => {
  const api = installPluginApi();
  host.actions.export_thing = { name: "Export", conditionMet: () => true, trigger: () => true };
  api.exposeAction("export_thing", {
    name: "export_thing_to",
    parameters: api.z.object({ path: api.z.string() }),
    execute: ({ path }, action) => `${action.name} to ${path}`,
  });
  expect(await executeText("export_thing_to", { path: "out.glb" })).toBe("Export to out.glb");
});

test("registerTool rejects invalid names, clashes, non-zod parameters, and missing description or execute", () => {
  const api = installPluginApi();
  createTool("place_cube", { description: "Built in.", parameters: z.object({}), execute: async () => "ok" });
  const valid = { description: "Fine.", execute: () => "ok" };

  expect(() => api.registerTool({ ...valid, name: "has space" })).toThrow(/must match/);
  expect(() => api.registerTool({ ...valid, name: "" })).toThrow(/must match/);
  expect(() => api.registerTool({ ...valid, name: "place_cube", plugin: "acme" })).toThrow('Prefix the name with your plugin id, for example "acme_place_cube"');
  expect(() => api.registerTool({ ...valid, name: "no_description", description: "  " })).toThrow(/non-empty description/);
  expect(() => api.registerTool({ ...valid, name: "bad_schema", parameters: { type: "object" } as unknown as z.ZodTypeAny })).toThrow(/MCP\.z\.object/);
  expect(() => api.registerTool({ name: "no_execute", description: "Fine.", execute: undefined as unknown as () => string })).toThrow(/execute function/);
  expect(() => api.exposeAction("")).toThrow(/id of a registered Blockbench Action/);
  expect(Object.keys(tools)).toEqual(["place_cube"]);
});

test("accepts a schema from another zod instance by duck typing", async () => {
  const api = installPluginApi();
  // A schema object from a second bundled zod has the same shape but a different class identity.
  const foreign = Object.assign(Object.create(null), z.object({ n: z.number() }));
  api.registerTool({ name: "foreign_schema", description: "Uses a foreign schema.", parameters: foreign, execute: ({ n }: { n: number }) => String(n * 2) });
  expect(await executeText("foreign_schema", { n: 21 })).toBe("42");
});

test("unregisterTool refuses built-in tools and uninstall removes only API tools, the global and the live queue", () => {
  const api = installPluginApi();
  createTool("builtin", { description: "Built in.", parameters: z.object({}), execute: async () => "ok" });
  greetingTool(api, "acme_tool", "acme");
  expect(api.unregisterTool("builtin")).toBe(false);
  expect(api.unregisterTool("does_not_exist")).toBe(false);
  expect(tools.builtin).toBeDefined();

  uninstallPluginApi();
  expect(Object.keys(tools)).toEqual(["builtin"]);
  expect(globalThis.MCP).toBeUndefined();
  expect(getPluginApi()).toBeUndefined();
  expect(host.unloadListeners).toHaveLength(0);
  expect(Array.isArray(globalThis.MCP_QUEUE)).toBe(true);

  // Pushes after uninstall queue again and are picked up by the next install.
  globalThis.MCP_QUEUE?.push(mcp => void greetingTool(mcp, "queued_for_reload"));
  expect(globalThis.MCP_QUEUE).toHaveLength(1);
  installPluginApi();
  expect(tools.queued_for_reload).toBeDefined();
  expect(api.listTools().map(tool => tool.name).toSorted()).toEqual(["builtin", "queued_for_reload"]);
});

test("the panel is told when the registry changes", () => {
  const dispatchEvent = mock((_event: Event) => true);
  const restoreDocument = installGlobals({ document: { dispatchEvent } });
  try {
    const api = installPluginApi();
    const dispose = greetingTool(api, "acme_tool");
    dispose();
    const types = dispatchEvent.mock.calls.map(([event]) => event.type);
    expect(types).toEqual([TOOL_REGISTRY_CHANGED, TOOL_REGISTRY_CHANGED]);
  } finally {
    restoreDocument();
  }
});

test("an MCP reload re-runs the entries of plugins that stayed loaded and forgets those that unloaded", () => {
  const acmeSetup = mock((mcp: IBlockbenchMcpApi) => void greetingTool(mcp, "acme_tool"));
  const otherSetup = mock((mcp: IBlockbenchMcpApi) => void greetingTool(mcp, "other_tool"));
  globalThis.MCP_QUEUE = [{ plugin: "acme", setup: acmeSetup }];
  installPluginApi();
  globalThis.MCP_QUEUE?.push({ plugin: "other", setup: otherSetup });
  expect(Object.keys(tools).toSorted()).toEqual(["acme_tool", "other_tool"]);

  // "other" unloads while MCP is loaded: its tool and its entry go.
  host.unloadListeners[0]?.({ plugin: { id: "other" } });
  expect(Object.keys(tools)).toEqual(["acme_tool"]);

  // MCP unloads: tools go, but acme's entry is queued again for the next load.
  uninstallPluginApi();
  expect(Object.keys(tools)).toEqual([]);
  expect(globalThis.MCP_QUEUE).toHaveLength(1);

  // MCP reloads: acme is back without acme doing anything; other stays gone.
  installPluginApi();
  expect(Object.keys(tools)).toEqual(["acme_tool"]);
  expect(acmeSetup).toHaveBeenCalledTimes(2);
  expect(otherSetup).toHaveBeenCalledTimes(1);
});

test("the API object is frozen and reports the plugin version", () => {
  const api = installPluginApi();
  expect(Object.isFrozen(api)).toBe(true);
  expect(typeof api.version).toBe("string");
  expect(api.z).toBe(z);
  expect(api.createJsonResult({ a: 1 })).toEqual({ content: [{ type: "text", text: JSON.stringify({ a: 1 }, null, 2) }], structuredContent: { a: 1 } });
});
