import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createTool,
  getAllToolDefinitions,
  registerToolsOnServer,
  refreshToolAvailability,
  tools,
} from "@/lib/factories";
import { createServer, getServer, setServer } from "@/server/server";
import { createTextureParameters } from "@/server/tools/texture";
import { registerModeTools } from "@/server/tools/modes";
import { installGlobals } from "@/tests/helpers/globals";

type RegistrationMode = "initial" | "session";

/** Fields the transform test's object schema hands to its object-level transform. */
interface ITransformFields {
  label: string;
  count: number;
}

const originalServer = getServer();
const originalCondition = Object.getOwnPropertyDescriptor(globalThis, "Condition");
let clients: Client[] = [];
let servers: ReturnType<typeof createServer>[] = [];

beforeEach(() => {
  Object.keys(tools).forEach((name) => delete tools[name]);
  const definitions = getAllToolDefinitions();
  Object.keys(definitions).forEach((name) => delete definitions[name]);
  const server = createServer();
  servers = [server];
  setServer(server);
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await Promise.all(servers.map((server) => server.close()));
  clients = [];
  servers = [];
  Object.keys(tools).forEach((name) => delete tools[name]);
  const definitions = getAllToolDefinitions();
  Object.keys(definitions).forEach((name) => delete definitions[name]);
  setServer(originalServer);
  if (originalCondition) {
    Object.defineProperty(globalThis, "Condition", originalCondition);
    return;
  }
  Reflect.deleteProperty(globalThis, "Condition");
});

async function connectClient(mode: RegistrationMode): Promise<Client> {
  const server = mode === "initial" ? getServer() : createServer();
  if (mode === "session") {
    servers.push(server);
    registerToolsOnServer(server);
  }

  const client = new Client({ name: "factory-regression-test", version: "1.0.0" });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe.each<RegistrationMode>(["initial", "session"])("%s registration", (mode) => {
  test("mode switching enables dependent tools in every connected session", async () => {
    interface IHostMode {
      id: string;
      name: string;
      condition: boolean;
      trigger(): void;
    }
    const host: { selected: IHostMode | false; options: Record<string, IHostMode> } = { selected: false, options: {} };
    ["edit", "animate"].forEach(id => {
      host.options[id] = { id, name: id, condition: true, trigger() { host.selected = this; } };
    });
    host.selected = host.options.edit!;
    const restore = installGlobals({
      Modes: host,
      Condition: (condition: unknown) => typeof condition === "function" ? condition() : condition !== false,
    });
    try {
      registerModeTools();
      createTool("animation_only", {
        description: "Requires Animate.", parameters: z.object({}),
        condition: () => Boolean(host.selected && host.selected.id === "animate"),
        execute: async () => "ready",
      });
      const first = await connectClient(mode);
      const second = await connectClient("session");
      const firstNotification = mock(() => {});
      const secondNotification = mock(() => {});
      first.setNotificationHandler(ToolListChangedNotificationSchema, firstNotification);
      second.setNotificationHandler(ToolListChangedNotificationSchema, secondNotification);
      expect((await first.listTools()).tools.map(tool => tool.name)).toEqual(["list_modes", "set_mode"]);

      const switched = await first.callTool({ name: "set_mode", arguments: { mode_id: "animate" } });
      expect(switched.isError).not.toBe(true);
      expect(switched.structuredContent).toMatchObject({ previous_mode: "edit", current_mode: "animate", changed: true });
      expect((await second.listTools()).tools.map(tool => tool.name)).toContain("animation_only");
      expect(firstNotification).toHaveBeenCalledTimes(1);
      expect(secondNotification).toHaveBeenCalledTimes(1);
      expect((await second.callTool({ name: "animation_only", arguments: {} })).isError).not.toBe(true);

      const repeated = await second.callTool({ name: "set_mode", arguments: { mode_id: "animate" } });
      expect(repeated.structuredContent).toMatchObject({ current_mode: "animate", changed: false });
      expect(firstNotification).toHaveBeenCalledTimes(1);
      await second.callTool({ name: "set_mode", arguments: { mode_id: "edit" } });
      expect((await first.listTools()).tools.map(tool => tool.name)).toEqual(["list_modes", "set_mode"]);
      expect(firstNotification).toHaveBeenCalledTimes(2);
      expect(secondNotification).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  test("updates every session using native conditions and coalesces change notifications", async () => {
    let available = false;
    const condition = { project: true, features: ["meshes"] };
    const evaluate = mock(() => available);
    Object.defineProperty(globalThis, "Condition", { configurable: true, value: evaluate });
    ["conditional_one", "conditional_two"].forEach(name => createTool(name, {
      description: "Requires native editor state.", parameters: z.object({}), condition,
      execute: async () => "done",
    }));
    createTool("manually_disabled", {
      description: "Explicitly disabled.", parameters: z.object({}), condition,
      execute: async () => "must not run",
    }, "stable", false);
    const first = await connectClient(mode);
    const second = await connectClient("session");
    const firstNotification = mock(() => {});
    const secondNotification = mock(() => {});
    first.setNotificationHandler(ToolListChangedNotificationSchema, firstNotification);
    second.setNotificationHandler(ToolListChangedNotificationSchema, secondNotification);
    expect(first.getServerCapabilities()?.tools).toEqual({ listChanged: true });
    expect((await first.listTools()).tools).toEqual([]);
    expect((await second.listTools()).tools).toEqual([]);
    expect(evaluate).toHaveBeenCalledWith(condition);

    available = true;
    refreshToolAvailability();
    expect((await first.listTools()).tools.map(tool => tool.name)).toEqual(["conditional_one", "conditional_two"]);
    expect((await second.listTools()).tools).toHaveLength(2);
    expect(firstNotification).toHaveBeenCalledTimes(1);
    expect(secondNotification).toHaveBeenCalledTimes(1);
    expect(tools.conditional_one?.enabled).toBe(true);
    expect(tools.manually_disabled?.enabled).toBe(false);
    refreshToolAvailability();
    await first.listTools();
    expect(firstNotification).toHaveBeenCalledTimes(1);

    available = false;
    refreshToolAvailability();
    expect((await second.listTools()).tools).toEqual([]);
    expect(firstNotification).toHaveBeenCalledTimes(2);
    expect(secondNotification).toHaveBeenCalledTimes(2);
    const result = await first.callTool({ name: "conditional_one", arguments: {} });
    expect(result.isError).toBe(true);
  });

  test("rechecks conditions before execution even when a client has a stale enabled list", async () => {
    let available = true;
    Object.defineProperty(globalThis, "Condition", { configurable: true, value: () => available });
    const execute = mock(async () => "must not run");
    createTool("stale_condition", {
      description: "Requires state.", parameters: z.object({}), condition: { project: true }, execute,
    });
    const client = await connectClient(mode);
    expect((await client.listTools()).tools).toHaveLength(1);
    available = false;
    const result = await client.callTool({ name: "stale_condition", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("unavailable") }]);
    expect(execute).not.toHaveBeenCalled();
  });

  test("preserves embedded resources, resource links, and explicit tool errors", async () => {
    const content = [
      { type: "resource" as const, resource: { uri: "blockbench://project/model.bbmodel", mimeType: "application/json", text: "{}" } },
      { type: "resource_link" as const, uri: "blockbench://project/model.bbmodel", name: "model.bbmodel", mimeType: "application/json" },
    ];
    createTool("resources", {
      description: "Return files.", parameters: z.object({}),
      execute: async () => ({ content, structuredContent: { uri: "blockbench://project/model.bbmodel" } }),
    });
    createTool("failure", {
      description: "Return an execution failure.", parameters: z.object({}),
      execute: async () => ({ content: [{ type: "text", text: "Unable to compile." }], isError: true }),
    });
    const client = await connectClient(mode);
    const result = await client.callTool({ name: "resources", arguments: {} });
    expect(result.content).toEqual(content);
    expect(result.structuredContent).toEqual({ uri: "blockbench://project/model.bbmodel" });
    expect((await client.callTool({ name: "failure", arguments: {} })).isError).toBe(true);
  });

  test("publishes annotations and the refined schema's input fields", async () => {
    const annotations = {
      title: "Create texture",
      destructiveHint: false,
      idempotentHint: false,
      readOnlyHint: false,
      openWorldHint: false,
    };
    createTool("create_texture", {
      description: "Create a texture.",
      annotations,
      parameters: createTextureParameters,
      execute: async () => "created",
    });
    const client = await connectClient(mode);
    const { tools: listedTools } = await client.listTools();

    expect(listedTools).toHaveLength(1);
    expect(listedTools[0]?.annotations).toEqual(annotations);
    expect(listedTools[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
        width: { type: "number", minimum: 16, maximum: 4096, default: 16 },
        layer_name: { type: "string" },
      },
      required: ["name"],
    });
    expect("shape" in createTextureParameters).toBe(false);
    expect(getAllToolDefinitions().create_texture?.inputSchema.name?.safeParse("mark").success).toBe(true);
  });

  test("publishes Copilot-compatible input schemas", async () => {
    const vector = z.array(z.number()).length(3);
    const tuple = z.tuple([z.number(), z.number(), z.number(), z.number()]);
    createTool("copilot_schema", {
      description: "Publish a portable schema.",
      parameters: z.object({
        position: vector,
        rotation: vector,
        color: tuple,
        options: z.record(z.unknown()),
      }),
      execute: async () => "published",
    });
    const client = await connectClient(mode);
    const inputSchema = (await client.listTools()).tools[0]?.inputSchema;

    expect(inputSchema).toMatchObject({
      type: "object",
      properties: {
        position: { type: "array", items: { type: "number" } },
        rotation: { type: "array", items: { type: "number" } },
        color: {
          type: "array",
          items: { anyOf: [{ type: "number" }, { type: "number" }, { type: "number" }, { type: "number" }] },
        },
        options: { type: "object", additionalProperties: true },
      },
    });
    expect(JSON.stringify(inputSchema)).not.toContain("$ref");
    expect(JSON.stringify(inputSchema)).not.toContain('"items":[');
    expect(JSON.stringify(inputSchema)).not.toContain('"additionalProperties":{}');
  });

  test("rejects every texture cross-field refinement before execution", async () => {
    const execute = mock(async () => "created");
    createTool("create_texture", {
      description: "Create a texture.",
      parameters: createTextureParameters,
      execute,
    });
    const client = await connectClient(mode);
    const cases = [
      {
        args: { name: "invalid", fill_color: "#ffffff" },
        error: "The 'layer_name' property is required",
      },
      {
        args: { name: "invalid", data: "image.png", fill_color: "#ffffff", layer_name: "base" },
        error: "The 'data' and 'fill_color' properties cannot both be defined",
      },
      {
        args: { name: "invalid", pbr_channel: "normal" },
        error: "The 'group' property is required",
      },
    ];
    await Promise.all(cases.map(async ({ args, error }) => {
      const result = await client.callTool({ name: "create_texture", arguments: args });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining(error) },
      ]);
    }));
    expect(execute).not.toHaveBeenCalled();
  });

  test("passes defaults and once-transformed output to execute", async () => {
    const fieldTransform = mock((value: string) => `${value}!`);
    const objectTransform = mock((value: ITransformFields) => ({
      ...value,
      parsed: true,
    }));
    const parameters = z.object({
      label: z.string().transform(fieldTransform),
      count: z.number().default(2),
    }).transform(objectTransform);
    const execute = mock(async (args: z.infer<typeof parameters>) => JSON.stringify(args));
    createTool("transform", { description: "Transform input.", parameters, execute });
    const client = await connectClient(mode);
    const result = await client.callTool({ name: "transform", arguments: { label: "mark" } });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ label: "mark!", count: 2, parsed: true }) },
    ]);
    expect(fieldTransform).toHaveBeenCalledTimes(1);
    expect(objectTransform).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ label: "mark!", count: 2, parsed: true });
  });

  test("awaits async refinements and rejects invalid input", async () => {
    const parameters = z.object({ name: z.string() }).refine(
      async ({ name }) => name !== "reserved",
      { message: "Name is reserved" },
    );
    const execute = mock(async () => "accepted");
    createTool("async_refinement", { description: "Validate input.", parameters, execute });
    const client = await connectClient(mode);
    const invalid = await client.callTool({ name: "async_refinement", arguments: { name: "reserved" } });
    const valid = await client.callTool({ name: "async_refinement", arguments: { name: "available" } });

    expect(invalid.isError).toBe(true);
    expect(invalid.content).toEqual([
      { type: "text", text: expect.stringContaining("Name is reserved") },
    ]);
    expect(valid.content).toEqual([{ type: "text", text: "accepted" }]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("preserves strict object validation before and inside effects", async () => {
    const parameters = z.object({ name: z.string() }).strict();
    const execute = mock(async () => "accepted");
    createTool("strict", { description: "Validate keys.", parameters, execute });
    createTool("strict_refined", {
      description: "Validate keys and name.",
      parameters: parameters.refine(({ name }) => name.length > 0),
      execute,
    });
    const client = await connectClient(mode);
    await Promise.all(["strict", "strict_refined"].map(async (name) => {
      const result = await client.callTool({ name, arguments: { name: "mark", unexpected: true } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining("Unrecognized key") },
      ]);
    }));
    expect(execute).not.toHaveBeenCalled();
  });

  test("preserves passthrough properties through a refined schema", async () => {
    const parameters = z.object({ name: z.string() }).passthrough()
      .refine(({ tag }) => tag === "official", { message: "Tag must be official" });
    createTool("passthrough", {
      description: "Preserve extra fields.",
      parameters,
      execute: async (args) => JSON.stringify(args),
    });
    const client = await connectClient(mode);
    const result = await client.callTool({
      name: "passthrough",
      arguments: { name: "mark", tag: "official" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ name: "mark", tag: "official" }) },
    ]);
  });
});
