import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";

// Run against the rebuilt desktop plugin. All edits stay in a separate test
// project; generated texture-set fixtures and evidence stay under artifacts/.
const endpoint = new URL(Bun.argv[2] ?? "http://localhost:3000/bb-mcp");
const output = new URL("../../artifacts/pbr/", import.meta.url);
const client = new Client({ name: "blockbench-pbr-smoke", version: "1.0.0" });
const checks: string[] = [];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value.map(record);
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
  checks.push(message);
  console.log(`PASS ${message}`);
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result;
}

async function json(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await call(name, args);
  const text = records(result.content).find(item => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`${name} returned no JSON text`);
  return record(JSON.parse(text));
}

async function exported(): Promise<Record<string, unknown>> {
  const result = await json("export_model", { codec_id: "project", max_content_length: 1000000 });
  if (result.truncated || typeof result.content !== "string") throw new Error("Expected complete project export");
  return record(JSON.parse(result.content));
}

function exportedTexture(model: Record<string, unknown>, name: string): Record<string, unknown> {
  const texture = records(model.textures).find(item => item.name === name);
  if (!texture) throw new Error(`Export has no texture named ${name}`);
  return texture;
}

async function unchangedAfterError(name: string, args: Record<string, unknown>, label: string): Promise<void> {
  const before = await exported();
  const history = JSON.stringify(await json("get_undo_stack"));
  const result = await client.callTool({ name, arguments: args });
  check(result.isError, `${label} returns an error`);
  const after = await exported();
  check(JSON.stringify({ textures: after.textures, groups: after.texture_groups }) === JSON.stringify({ textures: before.textures, groups: before.texture_groups }), `${label} preserves textures and groups`);
  check(JSON.stringify(await json("get_undo_stack")) === history, `${label} preserves undo history`);
}

async function material(id: string): Promise<Record<string, unknown>> {
  return json("get_material_info", { material: id });
}

function channelNames(info: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(records(info.textures).map(texture => [String(texture.pbr_channel), texture.name]));
}

async function checkUniformPreview(id: string, color: number[], roughness: number, label: string): Promise<void> {
  const preview = await json("risky_eval", { code: `(() => { const group = TextureGroup.all.find(item => item.uuid === ${JSON.stringify(id)}); if (!group) throw new Error('Missing preview material'); const material = group.material; return { color: material.color.toArray(), opacity: material.opacity, roughness: material.roughness }; })()` });
  check(Array.isArray(preview.color) && preview.color.every((value, index) => typeof value === "number" && Math.abs(value - color[index] / 255) < 1e-8), `${label} restores cached preview RGB`);
  check(typeof preview.opacity === "number" && Math.abs(preview.opacity - color[3] / 255) < 1e-8, `${label} restores cached preview opacity`);
  check(typeof preview.roughness === "number" && Math.abs(preview.roughness - roughness / 255) < 1e-8, `${label} restores cached preview roughness`);
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  await call("create_project", { name: "PBR MCP Release Smoke", format: "free" });
  const capabilities = await json("get_capabilities");
  check(record(record(capabilities.format).features).pbr === true, "test project supports PBR");

  const names = { color: "PBR Smoke Color", replacement: "PBR Smoke Replacement", normal: "PBR Smoke Normal", height: "PBR Smoke Height", mer: "PBR Smoke MER" };
  const image = await call("create_texture", { name: names.color, width: 16, height: 16, fill_color: "#808080", layer_name: "Base" });
  const imageData = records(image.content).find(item => item.type === "image")?.data;
  check(typeof imageData === "string", "texture creation provides PNG fixture data");
  await call("create_texture", { name: names.replacement, width: 16, height: 16, fill_color: "#ff8844", layer_name: "Base" });
  await call("create_texture", { name: names.normal, width: 16, height: 16, fill_color: "#8080ff", layer_name: "Base" });
  await call("create_texture", { name: names.height, width: 16, height: 16, fill_color: "#808080", layer_name: "Base" });
  await call("create_texture", { name: names.mer, width: 16, height: 16, fill_color: "#000080", layer_name: "Base" });

  await unchangedAfterError("add_texture_group", { name: "PBR Invalid Group", textures: [names.color, "__missing_texture__"] }, "mixed valid/invalid group references");
  await unchangedAfterError("create_texture", { name: "PBR Invalid Texture", group: "__missing_material__", pbr_channel: "color" }, "texture creation with missing group");
  await unchangedAfterError("create_pbr_material", { name: "PBR Invalid Depth", normal_texture: names.normal, height_texture: names.height }, "normal and height together");
  await unchangedAfterError("create_pbr_material", { name: "PBR Invalid MER", mer_texture: names.mer, color_value: [255, 255, 255, 255] }, "MER image without color image");
  await unchangedAfterError("create_pbr_material", { name: "PBR Duplicate Channels", color_texture: names.color, normal_texture: names.color }, "same texture in multiple channels");

  const created = await json("create_pbr_material", { name: "PBR Smoke Material", color_texture: names.color, normal_texture: names.normal, mer_value: [0, 0, 160] });
  const id = record(created.material).uuid;
  check(typeof id === "string", "material creation returns its UUID");
  const createdInfo = await material(id);
  check(channelNames(createdInfo).color === names.color && channelNames(createdInfo).normal === names.normal, "material contains requested color and normal maps");
  check(records((await exported()).texture_groups).some(group => group.uuid === id), "project export contains created material");
  await call("undo");
  const undoneCreation = await exported();
  check(!records(undoneCreation.texture_groups ?? []).some(group => group.uuid === id), "creation undo removes the material group");
  check(!exportedTexture(undoneCreation, names.color).group && !exportedTexture(undoneCreation, names.normal).group, "creation undo restores original texture membership");
  await call("redo");
  check(JSON.stringify(await material(id)) === JSON.stringify(createdInfo), "creation redo restores channels and material configuration");

  await unchangedAfterError("configure_material", { material: id, color_texture: "none", normal_texture: "__missing_texture__" }, "configure with a missing incoming texture");
  await call("assign_texture_channel", { material: id, texture: names.replacement, channel: "color" });
  check(channelNames(await material(id)).color === names.replacement, "assignment replaces the color channel");
  check(!exportedTexture(await exported(), names.color).group, "assignment detaches the previous color map");
  await call("undo");
  check(channelNames(await material(id)).color === names.color, "assignment undo restores previous color map");
  check(!exportedTexture(await exported(), names.replacement).group, "assignment undo restores incoming texture membership");
  await call("redo");
  check(channelNames(await material(id)).color === names.replacement, "assignment redo restores replacement");

  await call("configure_material", { material: id, normal_texture: "none", height_texture: names.height, mer_value: [0, 0, 90] });
  const heightInfo = await material(id);
  check(channelNames(heightInfo).height === names.height && !channelNames(heightInfo).normal, "configure switches normal to height explicitly");
  const detachedNormal = exportedTexture(await exported(), names.normal);
  check(!detachedNormal.group && detachedNormal.pbr_channel === "normal", "displaced normal map retains its channel metadata");
  await call("undo");
  check(channelNames(await material(id)).normal === names.normal, "configure undo restores normal channel");
  check(JSON.stringify(record((await material(id)).config).mer_value) === "[0,0,160]", "configure undo restores uniform MER values");
  await call("redo");
  check(JSON.stringify(await material(id)) === JSON.stringify(heightInfo), "configure redo restores height and uniform MER values");

  await call("assign_texture_channel", { material: id, texture: names.mer, channel: "mer" });
  check(channelNames(await material(id)).mer === names.mer, "MER image assignment works with a color map");
  await unchangedAfterError("configure_material", { material: id, color_texture: "none", color_value: [128, 128, 128, 255] }, "removing color while MER remains");
  await call("configure_material", { material: id, color_texture: "none", mer_texture: "none", color_value: [12, 34, 56, 255], mer_value: [0, 0, 200], subsurface_value: 32 });
  const uniform = await material(id);
  check(JSON.stringify(record(uniform.config).color_value) === "[12,34,56,255]" && record(uniform.config).subsurface_value === 32, "uniform color and subsurface values are applied");
  await call("undo");
  check(channelNames(await material(id)).mer === names.mer && channelNames(await material(id)).color === names.replacement, "uniform conversion undo restores both maps");
  await call("redo");
  check(JSON.stringify(await material(id)) === JSON.stringify(uniform), "uniform conversion redo restores configuration");

  await call("create_texture", { name: "PBR Smoke Grouped Color", group: "PBR Smoke Material", pbr_channel: "color", width: 16, height: 16 });
  check(channelNames(await material(id)).color === "PBR Smoke Grouped Color", "create_texture resolves a material name and assigns the channel");
  await call("undo");
  check(JSON.stringify(await material(id)) === JSON.stringify(uniform), "grouped texture undo restores material configuration");
  check(!records((await exported()).textures).some(texture => texture.name === "PBR Smoke Grouped Color"), "grouped texture undo removes the new texture");
  await call("redo");
  check(channelNames(await material(id)).color === "PBR Smoke Grouped Color", "grouped texture redo restores its material channel");

  const probe = await json("create_pbr_material", { name: "PBR Preview Probe", color_value: [10, 20, 30, 128], mer_value: [0, 0, 40] });
  const probeId = record(probe.material).uuid;
  check(typeof probeId === "string", "preview probe returns a material UUID");
  await checkUniformPreview(probeId, [10, 20, 30, 128], 40, "uniform creation");
  await call("configure_material", { material: probeId, color_value: [50, 60, 70, 255], mer_value: [0, 0, 80] });
  await checkUniformPreview(probeId, [50, 60, 70, 255], 80, "uniform configure");
  await call("undo");
  await checkUniformPreview(probeId, [10, 20, 30, 128], 40, "uniform undo");
  await call("redo");
  await checkUniformPreview(probeId, [50, 60, 70, 255], 80, "uniform redo");

  const png = Buffer.from(imageData, "base64");
  await Promise.all(["color.png", "normal.png", "mer.png"].map(name => Bun.write(new URL(`fixtures/${name}`, output), png)));
  const importUrl = new URL("fixtures/smoke.texture_set.json", output);
  const importPath = fileURLToPath(importUrl);
  await Bun.write(importUrl, JSON.stringify({ format_version: "1.16.100", "minecraft:texture_set": { color: "color", normal: "normal", metalness_emissive_roughness: "mer" } }));
  const beforeImport = await exported();
  const imported = await json("import_texture_set", { path: importPath });
  const importedId = record(imported.material).uuid;
  check(typeof importedId === "string", "import returns the created material UUID");
  const importedInfo = await material(importedId);
  check(records(importedInfo.textures).length === 3, "import loads all three channel images");
  check(records((await exported()).textures).length === records(beforeImport.textures).length + 3, "import export contains three new textures");
  await call("undo");
  const undoneImport = await exported();
  check(records(undoneImport.textures).length === records(beforeImport.textures).length, "import undo removes all imported textures");
  check(!records(undoneImport.texture_groups ?? []).some(group => group.uuid === importedId), "import undo removes the material");
  await call("redo");
  check(JSON.stringify(await material(importedId)) === JSON.stringify(importedInfo), "import redo restores channels and metadata");

  const invalidUrl = new URL("fixtures/invalid.texture_set.json", output);
  await Bun.write(invalidUrl, JSON.stringify({ format_version: "1.16.100", "minecraft:texture_set": { color: "__missing_image__" } }));
  await unchangedAfterError("import_texture_set", { path: fileURLToPath(invalidUrl) }, "missing imported image");
  await Bun.write(new URL("fixtures/broken.png", output), "not an image");
  await Bun.write(invalidUrl, JSON.stringify({ format_version: "1.16.100", "minecraft:texture_set": { color: "broken" } }));
  await unchangedAfterError("import_texture_set", { path: fileURLToPath(invalidUrl) }, "corrupt imported image");
  await Bun.write(invalidUrl, "{broken JSON");
  await unchangedAfterError("import_texture_set", { path: fileURLToPath(invalidUrl) }, "invalid imported JSON");

  await Bun.write(new URL("smoke-results.json", output), JSON.stringify({ checks }, null, 2));
  console.log(`Completed ${checks.length} PBR live checks.`);
} finally {
  await client.close();
}
