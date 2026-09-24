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

async function connect(root: string, clientName: string, renderer = new BbRenderer({ node: "node", concurrency: 1, timeoutMs: 1000, prepare: () => Promise.reject(new Error("runtime disabled in tests")) })): Promise<ISession> {
  const store = new ModelStore({ roots: [root] });
  const server = createHeadlessServer((mcp) => ({
    store,
    renderer,
    scratchDir: join(root, "renders"),
    aiDisclosure: true,
    clientName: () => mcp.server.getClientVersion()?.name ?? "unknown",
    webApp: { enabled: true, baseUrl: "https://web.blockbench.net/", inlineMax: 8000, browserMax: 2_000_000, launcherDir: join(root, "renders", "web-app") },
    // A harmless stand-in for Blockbench: the test runtime itself.
    desktop: { executable: process.execPath, mcpUrl: "http://127.0.0.1:9/bb-mcp" },
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

  test("render tools report why the render engine is unavailable", async () => {
    const session = await connect(root, "renderer");
    await session.json("bbmodel_create", { file: "r.bbmodel" });
    const result = await session.call("bbmodel_render", { file: "r.bbmodel" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("The render engine is not available: runtime disabled in tests");
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

  test("write results link to the web app, and the link carries the model as written", async () => {
    const session = await connect(root, "linker");
    const created = await session.json<{ revision: string; web_app: { url: string } }>("bbmodel_create", { file: "box.bbmodel", name: "box" });
    expect(created.web_app.url.startsWith("https://web.blockbench.net/#loadtype=json&loadname=box.bbmodel&loaddata=")).toBe(true);
    const edited = await session.json<{ web_app: { url: string } }>("bbmodel_edit", {
      file: "box.bbmodel",
      expected_revision: created.revision,
      operations: [{ op: "add_cube", name: "fish & chips", from: [0, 0, 0], to: [4, 4, 4] }],
    });
    // Blockbench's web.ts: one decodeURIComponent over the fragment, split on &, split at the first =.
    const query = decodeURIComponent(new URL(edited.web_app.url).hash.substring(1));
    const loaddata = query.split("&").map((part) => part.split(/=\s*(.+)/)).find(([key]) => key === "loaddata")?.[1] ?? "";
    const onDisk = JSON.parse(await Bun.file(join(root, "box.bbmodel")).text()) as { elements: unknown[] };
    expect((JSON.parse(loaddata) as { elements: unknown[] }).elements).toEqual(onDisk.elements);

    const textured = await session.json<{ web_app: { url?: string } }>("bbmodel_add_texture", { file: "box.bbmodel", image: ONE_PIXEL_PNG, name: "paint", assign_to: ["fish & chips"] });
    expect(decodeURIComponent(textured.web_app.url ?? "")).toContain("data:image/png;base64");

    const geometry = await session.json<{ web_app: { url: string } }>("bbmodel_export_bedrock_geometry", { file: "box.bbmodel" });
    expect(geometry.web_app.url).toContain("loadname=box.geo.json");
    const exported = await session.json<{ path: string; web_app: { url: string } }>("bbmodel_export_bedrock_geometry", { file: "box.bbmodel", output: "out/box.geo.json" });
    expect(exported.web_app.url).toContain("loadname=box.geo.json");
    expect(await Bun.file(exported.path).exists()).toBe(true);
    const legacy = await session.json<{ web_app: { url: string } }>("bbmodel_convert_legacy", { file: "box.bbmodel", output: "box.v4.bbmodel" });
    expect(legacy.web_app.url).toContain("loadname=box.v4.bbmodel");
  });

  test("bbmodel_web_url makes tiered links on demand", async () => {
    const session = await connect(root, "linker");
    const { revision } = await session.json<{ revision: string }>("bbmodel_create", { file: "big.bbmodel" });
    await session.json("bbmodel_edit", {
      file: "big.bbmodel",
      expected_revision: revision,
      operations: Array.from({ length: 60 }, (_, i) => ({ op: "add_cube", name: `c${i}`, from: [i, 0, 0], to: [i + 1, 1, 1] })),
    });
    const short = await session.json<{ web_app: { url?: string; launcher?: { path: string } } }>("bbmodel_web_url", { file: "big.bbmodel", inline_max: 500 });
    expect(short.web_app.url).toBeUndefined();
    expect(await Bun.file(short.web_app.launcher?.path ?? "").exists()).toBe(true);
    const full = await session.json<{ web_app: { url?: string } }>("bbmodel_web_url", { file: "big.bbmodel", inline_max: 200_000 });
    expect(full.web_app.url).toBeDefined();
  });

  test("meshes are built in free models and refused where the format has none", async () => {
    const session = await connect(root, "mesher");
    const free = await session.json<{ revision: string }>("bbmodel_create", { file: "free.bbmodel", format: "free" });
    const built = await session.json<{ results: { uuid?: string }[] }>("bbmodel_edit", {
      file: "free.bbmodel",
      expected_revision: free.revision,
      operations: [
        { op: "add_texture", name: "paint", source: ONE_PIXEL_PNG, width: 1, height: 1 },
        { op: "add_mesh_primitive", shape: "cylinder", name: "pipe", sides: 8 },
        { op: "edit_mesh", target: "pipe", actions: [{ action: "move_vertices", offset: [0, 4, 0] }] },
        { op: "assign_texture", targets: ["pipe"], texture: "paint" },
        { op: "add_mesh", name: "tri", vertices: [[0, 0, 0], [8, 0, 0], [0, 8, 0]], faces: [{ vertices: [0, 1, 2] }] },
      ],
    });
    expect(built.results).toHaveLength(5);
    const saved = JSON.parse(await Bun.file(join(root, "free.bbmodel")).text()) as { elements: { type: string; name: string; faces: Record<string, { texture?: number }> }[] };
    const pipe = saved.elements.find((element) => element.name === "pipe");
    expect(pipe?.type).toBe("mesh");
    expect(Object.values(pipe?.faces ?? {}).every((face) => face.texture === 0)).toBe(true);

    const bedrock = await session.json<{ revision: string }>("bbmodel_create", { file: "entity.bbmodel", format: "bedrock" });
    const refused = await session.call("bbmodel_edit", { file: "entity.bbmodel", expected_revision: bedrock.revision, operations: [{ op: "add_mesh_primitive", shape: "sphere" }] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.type === "text" ? refused.content[0].text : "").toContain("nothing was written");
  });

  test("java_block models refuse rotations Java cannot hold, and round-trip through Java model JSON", async () => {
    const session = await connect(root, "java");
    const created = await session.json<{ revision: string }>("bbmodel_create", { file: "lamp.bbmodel", format: "java_block" });
    const refused = await session.call("bbmodel_edit", {
      file: "lamp.bbmodel",
      expected_revision: created.revision,
      operations: [{ op: "add_cube", name: "far", from: [0, 0, 0], to: [48, 4, 4] }],
    });
    expect(refused.isError).toBe(true);
    await session.json("bbmodel_edit", {
      file: "lamp.bbmodel",
      operations: [
        { op: "add_cube", name: "base", from: [4, 0, 4], to: [12, 2, 12] },
        { op: "add_cube", name: "arm", from: [7, 2, 7], to: [9, 12, 9], rotation: [0, 0, 22.5], origin: [8, 2, 8] },
      ],
    });
    const exported = await session.json<{ path: string; notes: string[] }>("bbmodel_export_java_block", { file: "lamp.bbmodel", output: "pack/assets/demo/models/block/lamp.json" });
    const json = JSON.parse(await Bun.file(exported.path).text()) as { elements: unknown[] };
    expect(json.elements).toHaveLength(2);
    const imported = await session.json<{ counts: { cubes: number } }>("bbmodel_import_java_block", { model: "pack/assets/demo/models/block/lamp.json", output: "lamp_again.bbmodel" });
    expect(imported.counts.cubes).toBe(2);

    const entity = await session.json<{ revision: string }>("bbmodel_create", { file: "mob.bbmodel", format: "modded_entity" });
    await session.json("bbmodel_edit", { file: "mob.bbmodel", expected_revision: entity.revision, operations: [{ op: "add_group", name: "body", origin: [0, 12, 0] }, { op: "add_cube", name: "torso", from: [-4, 12, -2], to: [4, 24, 2], parent: "body" }] });
    const java = await session.json<{ code: string; class_name: string }>("bbmodel_export_modded_entity", { file: "mob.bbmodel", template: "1.17" });
    expect(java.code).toContain("class ");
    expect(java.code).toContain("body");
  });

  test("blockbench_launch starts the configured app and refuses files outside the workspace", async () => {
    const session = await connect(root, "launcher");
    const { tools } = await session.client.listTools();
    expect(tools.find((tool) => tool.name === "blockbench_launch")?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    const launched = await session.json<{ launched: boolean; command: string[]; pid: number }>("blockbench_launch", {});
    expect(launched).toMatchObject({ launched: true, command: [process.execPath] });
    expect(launched.pid).toBeGreaterThan(0);
    const outside = await session.call("blockbench_launch", { file: "../../elsewhere/model.bbmodel" });
    expect(outside.isError).toBe(true);
    const missing = await session.call("blockbench_launch", { file: "nope.bbmodel" });
    expect(missing.content[0]?.type === "text" ? missing.content[0].text : "").toContain("File not found");
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
