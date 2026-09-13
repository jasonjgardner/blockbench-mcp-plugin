import { beforeAll, beforeEach, expect, test } from "bun:test";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";

interface IHostCodec {
  id: string;
  name: string;
  extension: string;
  compile: () => unknown;
  fileName?: () => string;
  export_action?: { condition: boolean | (() => boolean) };
}

let tools: IToolFixture;
let codecs: Record<string, IHostCodec>;
let project: { uuid: string; name: string; texture_width: number; texture_height: number };

beforeAll(async () => {
  tools = await loadToolDefinitions({
    entries: ["server/tools/export.ts", "server/tools/project.ts"],
    register: ["registerExportTools", "registerProjectTools"],
  });
});

beforeEach(() => {
  project = { uuid: "project-1", name: "Snow fox", texture_width: 32, texture_height: 32 };
  codecs = {
    project: { id: "project", name: "Blockbench Project", extension: "bbmodel", compile: () => ({ name: "Snow fox" }) },
  };
});

useGlobals(() => ({
  Project: project,
  Format: { id: "free", name: "Generic Model", codec: { id: "project" } },
  Formats: { free: { id: "free" } },
  Codecs: codecs,
  Condition: (condition: unknown) => typeof condition === "function" ? condition() : condition !== false,
  Group: class { static all = []; },
  Cube: { all: [] },
  Mesh: { all: [] },
  Texture: { all: [] },
  Outliner: { root: [], elements: [] },
  newProject: () => true,
}));

async function exportModel(input: Record<string, unknown> = {}): Promise<CallToolResult> {
  return CallToolResultSchema.parse(await tools.call("export_model", input));
}

function metadata(result: CallToolResult): Record<string, unknown> {
  const text = result.content.find(item => item.type === "text");
  if (!text || text.type !== "text") throw new Error("Expected JSON metadata.");
  const parsed: unknown = JSON.parse(text.text);
  expect(parsed).toEqual(result.structuredContent);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected metadata object.");
  return parsed as Record<string, unknown>;
}

test("default exports preserve JSON content and add a readable project-file link", async () => {
  const result = await exportModel();
  expect(metadata(result)).toMatchObject({ content: '{\n  "name": "Snow fox"\n}', encoding: "utf-8", truncated: false });
  expect(result.content.filter(item => item.type === "resource")).toHaveLength(0);
  expect(result.content.find(item => item.type === "resource_link")).toMatchObject({
    uri: "blockbench://project/project-1.bbmodel", name: "Snow fox.bbmodel", mimeType: "application/json",
  });
});

test("embedded JSON exports include complete asynchronously compiled bytes with a unique file URI", async () => {
  const model = { name: "雪狐", meta: { model_format: "free" }, elements: [] };
  codecs.project!.compile = async () => model;
  codecs.project!.fileName = () => "D:\\private\\Snow fox.bbmodel";
  const first = await exportModel({ result_format: "embedded" });
  const second = await exportModel({ result_format: "embedded" });
  const embedded = first.content.find(item => item.type === "resource");
  if (!embedded || embedded.type !== "resource" || !("text" in embedded.resource)) throw new Error("Expected text resource.");
  expect(JSON.parse(embedded.resource.text)).toEqual(model);
  expect(embedded.resource.mimeType).toBe("application/json");
  expect(embedded.resource.uri).toMatch(/^blockbench:\/\/export\/project-1\/[^/]+\/Snow%20fox\.bbmodel$/);
  expect(metadata(first)).toMatchObject({ content: null, resource_uri: embedded.resource.uri });
  expect(metadata(second).resource_uri).not.toBe(embedded.resource.uri);
});

test("binary DataView exports preserve the byte range and identify glTF binary output as .glb", async () => {
  const bytes = new Uint8Array([99, 0, 1, 2, 255, 99]);
  codecs.gltf = {
    id: "gltf", name: "glTF", extension: "gltf", fileName: () => "Fox.gltf",
    compile: () => new DataView(bytes.buffer, 1, 4),
  };
  const result = await exportModel({ codec_id: "gltf", result_format: "embedded" });
  const embedded = result.content.find(item => item.type === "resource");
  if (!embedded || embedded.type !== "resource" || !("blob" in embedded.resource)) throw new Error("Expected binary resource.");
  expect([...Buffer.from(embedded.resource.blob, "base64")]).toEqual([0, 1, 2, 255]);
  expect(embedded.resource.mimeType).toBe("model/gltf-binary");
  expect(embedded.resource.uri.endsWith("/Fox.glb")).toBe(true);
  expect(metadata(result)).toMatchObject({ byte_length: 4, encoding: "base64", content: null });
});

test("truncated embedded-mode exports return a marked preview instead of an incomplete resource", async () => {
  codecs.project!.compile = () => "0123456789";
  const result = await exportModel({ result_format: "embedded", max_content_length: 5 });
  expect(metadata(result)).toMatchObject({ content: "01234", truncated: true, resource_uri: null });
  expect(result.content.some(item => item.type === "resource")).toBe(false);
});

test("a zero content limit omits embedded bytes and previews while retaining project access", async () => {
  const result = await exportModel({ result_format: "embedded", max_content_length: 0 });
  expect(metadata(result)).toMatchObject({ content: null, resource_uri: null });
  expect(result.content.some(item => item.type === "resource")).toBe(false);
  expect(result.content.some(item => item.type === "resource_link")).toBe(true);
});

test("native export action conditions prevent compilation and appear in codec discovery", async () => {
  let compiled = false;
  codecs.project!.export_action = { condition: false };
  codecs.project!.compile = () => { compiled = true; return "model"; };
  await expect(exportModel()).rejects.toThrow("unavailable in the current project or mode");
  expect(compiled).toBe(false);
  const result = await tools.call("list_export_formats", {});
  if (typeof result !== "string") throw new Error("Expected codec list JSON.");
  expect(JSON.parse(result)).toMatchObject({ codecs: [{ id: "project", available: false }] });
  codecs.project!.export_action.condition = true;
  await exportModel();
  expect(compiled).toBe(true);
});

test("an asynchronous export retains the originating project identity after the user changes tabs", async () => {
  codecs.project!.compile = async () => {
    Object.assign(globalThis, { Project: { ...project, uuid: "project-2", name: "Other project" } });
    return "model";
  };
  const result = await exportModel({ result_format: "embedded" });
  expect(metadata(result).file_name).toBe("Snow fox");
  expect(String(metadata(result).resource_uri)).toContain("/project-1/");
  expect(result.content.some(item => item.type === "resource_link")).toBe(false);
});

test("a throwing third-party export condition disables that codec without breaking discovery", async () => {
  codecs.broken = {
    id: "broken", name: "Broken plugin codec", extension: "json", compile: () => "{}",
    export_action: { condition: () => { throw new Error("Plugin failed"); } },
  };
  const result = await tools.call("list_export_formats", {});
  if (typeof result !== "string") throw new Error("Expected codec list JSON.");
  expect(JSON.parse(result)).toMatchObject({
    codecs: [{ id: "broken", available: false }, { id: "project", available: true }],
  });
  await expect(exportModel({ codec_id: "broken" })).rejects.toThrow("unavailable in the current project or mode");
});

test("project inspection supplies structured JSON and a file link without compiling the model", async () => {
  codecs.project!.compile = () => { throw new Error("Inspection must not compile the full project"); };
  const result = CallToolResultSchema.parse(await tools.call("get_project_info", {}));
  expect(metadata(result)).toMatchObject({ project: { uuid: "project-1", name: "Snow fox" }, counts: { cubes: 0 } });
  expect(result.content.find(item => item.type === "resource_link")).toMatchObject({ uri: "blockbench://project/project-1.bbmodel" });
});

test("project creation preserves its confirmation and links the new project file", async () => {
  const result = CallToolResultSchema.parse(await tools.call("create_project", { name: "Arctic fox", format: "free" }));
  expect(result.content[0]).toMatchObject({ type: "text", text: 'Created project with name "Arctic fox" (UUID: project-1) and format "free".' });
  expect(result.content.find(item => item.type === "resource_link")).toMatchObject({ name: "Arctic fox.bbmodel" });
});
