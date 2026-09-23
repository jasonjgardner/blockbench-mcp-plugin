import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ModelStore } from "./document/store";
import { BbRenderer, buildRenderArgs, Semaphore } from "./render/bb-render";
import { createHeadlessServer, HEADLESS_TOOLS } from "./server";

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface ISession {
  client: Client;
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  json<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T>;
}

async function connect(root: string, clientName: string, renderer = new BbRenderer({ cli: undefined, node: "node", concurrency: 1, timeoutMs: 1000 })): Promise<ISession> {
  const store = new ModelStore({ roots: [root] });
  const server = createHeadlessServer((mcp) => ({
    store,
    renderer,
    scratchDir: join(root, "renders"),
    aiDisclosure: true,
    clientName: () => mcp.server.getClientVersion()?.name ?? "unknown",
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const json = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await call(name, args);
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as T;
  };
  return { client, call, json };
}

describe("headless MCP server", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-headless-server-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("lists every tool with read-only hints", async () => {
    const { client } = await connect(root, "lister");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(HEADLESS_TOOLS.map((tool) => tool.name).toSorted());
    expect(tools.find((tool) => tool.name === "bbmodel_info")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "bbmodel_edit")?.annotations?.readOnlyHint).toBe(false);
  });

  test("create → edit → inspect → validate → export, end to end", async () => {
    const session = await connect(root, "builder-agent");
    const created = await session.json<{ revision: string }>("bbmodel_create", { file: "chair.bbmodel", format: "bedrock", name: "chair", resolution: { width: 32, height: 32 } });
    const edited = await session.json<{ revision: string; results: { uuid?: string }[] }>("bbmodel_edit", {
      file: "chair.bbmodel",
      expected_revision: created.revision,
      operations: [
        { op: "add_group", name: "chair", origin: [0, 0, 0] },
        { op: "add_cube", name: "seat", from: [-6, 6, -6], to: [6, 8, 6], parent: "chair" },
        { op: "add_cube", name: "back", from: [-6, 8, 4], to: [6, 20, 6], parent: "chair" },
        ...[["leg_front_l", 4, -6], ["leg_front_r", -6, -6], ["leg_back_l", 4, 4], ["leg_back_r", -6, 4]].map(([name, x, z]) => ({
          op: "add_cube",
          name,
          from: [x, 0, z],
          to: [Number(x) + 2, 6, Number(z) + 2],
          parent: "chair",
        })),
      ],
    });
    expect(edited.results).toHaveLength(7);

    const info = await session.json<{ counts: { cubes: number }; ai_used: boolean; box_uv: boolean }>("bbmodel_info", { file: "chair.bbmodel" });
    expect(info).toMatchObject({ counts: { cubes: 6 }, ai_used: true, box_uv: true });

    const found = await session.json<{ total: number }>("bbmodel_find_elements", { file: "chair.bbmodel", name: "leg_*" });
    expect(found.total).toBe(4);

    const validation = await session.json<{ summary: { errors: number; warnings: number; passed: boolean }; self_test: { discriminates: boolean | null }[] }>("bbmodel_validate", { file: "chair.bbmodel", self_test: true });
    expect(validation.summary).toEqual({ errors: 0, warnings: 0, passed: true });
    expect(validation.self_test.filter((result) => result.discriminates === false)).toEqual([]);

    const geometry = await session.json<{ geometry: Record<string, unknown> }>("bbmodel_export_bedrock_geometry", { file: "chair.bbmodel", identifier: "chair" });
    expect(JSON.stringify(geometry.geometry)).toContain("geometry.chair");

    const legacy = await session.json<{ path: string }>("bbmodel_convert_legacy", { file: "chair.bbmodel", output: "chair.legacy.bbmodel" });
    const legacyDoc = JSON.parse(await Bun.file(legacy.path).text()) as { meta: { format_version: string }; groups?: unknown };
    expect(legacyDoc.meta.format_version).toBe("4.10");
    expect(legacyDoc.groups).toBeUndefined();

    const withTexture = await session.json<{ texture: { width: number } }>("bbmodel_add_texture", { file: "chair.bbmodel", image: ONE_PIXEL_PNG, name: "wood", assign_to: ["chair"] });
    expect(withTexture.texture.width).toBe(1);
    const textured = await session.json<{ total: number }>("bbmodel_find_elements", { file: "chair.bbmodel", texture: "wood" });
    expect(textured.total).toBe(6);

    const saved = JSON.parse(await Bun.file(join(root, "chair.bbmodel")).text()) as { ai_agents: string };
    expect(saved.ai_agents).toBe("builder-agent");
  });

  test("two agents editing one file: a stale revision is refused, not merged silently", async () => {
    const alice = await connect(root, "alice");
    const bob = await connect(root, "bob");
    const { revision } = await alice.json<{ revision: string }>("bbmodel_create", { file: "shared.bbmodel" });
    await alice.json("bbmodel_edit", { file: "shared.bbmodel", expected_revision: revision, operations: [{ op: "add_cube", name: "a", from: [0, 0, 0], to: [1, 1, 1] }] });
    const conflict = await bob.call("bbmodel_edit", { file: "shared.bbmodel", expected_revision: revision, operations: [{ op: "add_cube", name: "b", from: [0, 0, 0], to: [1, 1, 1] }] });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]?.type === "text" ? conflict.content[0].text : "").toContain("Revision conflict");
  });

  test("errors come back as tool errors, and paths outside the workspace are refused", async () => {
    const session = await connect(root, "tester");
    const outside = await session.call("bbmodel_info", { file: "../../etc/model.bbmodel" });
    expect(outside.isError).toBe(true);
    const invalid = await session.call("bbmodel_edit", { file: "x.bbmodel", operations: [{ op: "explode" }] });
    expect(invalid.isError).toBe(true);
  });

  test("render tools explain how to install bb-render when it is missing", async () => {
    const session = await connect(root, "renderer");
    await session.json("bbmodel_create", { file: "r.bbmodel" });
    const result = await session.call("bbmodel_render", { file: "r.bbmodel" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("bb-render was not found");
  });

  test("a render never replaces an existing workspace PNG unless overwrite is set", async () => {
    const session = await connect(root, "renderer");
    await session.json("bbmodel_create", { file: "r.bbmodel" });
    await Bun.write(join(root, "skin.png"), Buffer.from(ONE_PIXEL_PNG.split(",")[1] ?? "", "base64"));
    const refused = await session.call("bbmodel_render", { file: "r.bbmodel", output: "skin.png" });
    expect(refused.content[0]?.type === "text" ? refused.content[0].text : "").toContain("already exists");
    const tools = await session.client.listTools();
    expect(tools.tools.find((tool) => tool.name === "bbmodel_render")?.annotations?.readOnlyHint).toBe(false);
  });
});

describe("bb-render bridge", () => {
  test("builds CLI arguments for a posed still", () => {
    expect(buildRenderArgs({ input: "m.bbmodel", output: "o.png", view: "front", width: 256, height: 256, clip: "walk", time: 0.5, orthographic: true })).toEqual([
      "m.bbmodel", "-o", "o.png", "--quiet", "--view", "front", "--width", "256", "--height", "256", "--start", "0.5", "--clip=walk", "--ortho",
    ]);
  });

  test("the semaphore never exceeds its limit", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        semaphore.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await Bun.sleep(5);
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
