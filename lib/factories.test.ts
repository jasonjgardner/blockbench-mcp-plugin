import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  createTool,
  getAllToolDefinitions,
  registerToolsOnServer,
  tools,
} from "@/lib/factories";
import { createServer, getServer, setServer } from "@/server/server";
import { createTextureParameters } from "@/server/tools/texture";

type RegistrationMode = "initial" | "session";

const originalServer = getServer();
let clients: Client[] = [];
let servers: ReturnType<typeof createServer>[] = [];

beforeEach(() => {
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
    const objectTransform = mock((value: { label: string; count: number }) => ({
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
