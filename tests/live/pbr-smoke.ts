import { type IToolRequest, type LiveSession, runLiveSuite, suiteArtifactPath } from "./harness";
import { record, records } from "./narrow";

// Run against the rebuilt desktop plugin. All edits stay in a separate test
// project; generated texture-set fixtures and evidence stay under artifacts/.

/**
 * Allowed error when comparing Three.js material channels (0..1 floats) with the
 * 8-bit values that were requested; exact division by 255 should round-trip.
 */
const MATERIAL_CHANNEL_TOLERANCE = 1e-8;
/** Largest value of an 8-bit color, opacity, or MER channel. */
const CHANNEL_MAX = 255;
/** Bedrock texture set schema version written into the import fixtures. */
const TEXTURE_SET_FORMAT_VERSION = "1.16.100";
/** Channel image fixtures written for import; each becomes one imported texture. */
const FIXTURE_IMAGES = ["color.png", "normal.png", "mer.png"];
/** Material name whose group create_texture must resolve by name. */
const MATERIAL_NAME = "PBR Smoke Material";

const names = { color: "PBR Smoke Color", replacement: "PBR Smoke Replacement", normal: "PBR Smoke Normal", height: "PBR Smoke Height", mer: "PBR Smoke MER" };

/** Extra solid textures created after the PNG-producing color texture, in creation order. */
const extraTextures = [
  { name: names.replacement, fill_color: "#ff8844" },
  { name: names.normal, fill_color: "#8080ff" },
  { name: names.height, fill_color: "#808080" },
  { name: names.mer, fill_color: "#000080" },
];

/** A request that must fail without changing textures, groups, or undo history. */
interface IRejectedChange {
  request: IToolRequest;
  label: string;
}

/** Invalid texture and material requests checked before any material exists. */
const invalidCreations: readonly IRejectedChange[] = [
  { request: { name: "add_texture_group", arguments: { name: "PBR Invalid Group", textures: [names.color, "__missing_texture__"] } }, label: "mixed valid/invalid group references" },
  { request: { name: "create_texture", arguments: { name: "PBR Invalid Texture", group: "__missing_material__", pbr_channel: "color" } }, label: "texture creation with missing group" },
  { request: { name: "create_pbr_material", arguments: { name: "PBR Invalid Depth", normal_texture: names.normal, height_texture: names.height } }, label: "normal and height together" },
  { request: { name: "create_pbr_material", arguments: { name: "PBR Invalid MER", mer_texture: names.mer, color_value: [255, 255, 255, 255] } }, label: "MER image without color image" },
  { request: { name: "create_pbr_material", arguments: { name: "PBR Duplicate Channels", color_texture: names.color, normal_texture: names.color } }, label: "same texture in multiple channels" },
];

/** Expected uniform preview state: RGBA bytes and the MER roughness byte. */
interface IUniformPreview {
  color: number[];
  roughness: number;
}

/** Blockbench expression reading the cached Three.js preview material of a texture group. */
function previewMaterialCode(id: string): string {
  return [
    `(() => { const group = TextureGroup.all.find(item => item.uuid === ${JSON.stringify(id)});`,
    "if (!group) throw new Error('Missing preview material'); const material = group.material;",
    "return { color: material.color.toArray(), opacity: material.opacity, roughness: material.roughness }; })()",
  ].join(" ");
}

function exportedTexture(model: Record<string, unknown>, name: string): Record<string, unknown> {
  const texture = records(model.textures).find(item => item.name === name);
  if (!texture) throw new Error(`Export has no texture named ${name}`);
  return texture;
}

async function unchangedAfterError(session: LiveSession, { request, label }: IRejectedChange): Promise<void> {
  const before = await session.exportProject();
  const history = JSON.stringify(await session.json("get_undo_stack"));
  const result = await session.attempt(request.name, request.arguments);
  session.check(result.isError, `${label} returns an error`);
  const after = await session.exportProject();
  session.check(JSON.stringify({ textures: after.textures, groups: after.texture_groups }) === JSON.stringify({ textures: before.textures, groups: before.texture_groups }),
    `${label} preserves textures and groups`);
  session.check(JSON.stringify(await session.json("get_undo_stack")) === history, `${label} preserves undo history`);
}

function material(session: LiveSession, id: string): Promise<Record<string, unknown>> {
  return session.json("get_material_info", { material: id });
}

function channelNames(info: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(records(info.textures).map(texture => [String(texture.pbr_channel), texture.name]));
}

function near(actual: unknown, expected: number): boolean {
  return typeof actual === "number" && Math.abs(actual - expected / CHANNEL_MAX) < MATERIAL_CHANNEL_TOLERANCE;
}

async function checkUniformPreview(session: LiveSession, id: string, { color, roughness }: IUniformPreview, label: string): Promise<void> {
  const preview = await session.json("risky_eval", { code: previewMaterialCode(id) });
  session.check(Array.isArray(preview.color) && preview.color.every((value: unknown, index: number) => near(value, color[index])), `${label} restores cached preview RGB`);
  session.check(near(preview.opacity, color[3]), `${label} restores cached preview opacity`);
  session.check(near(preview.roughness, roughness), `${label} restores cached preview roughness`);
}

async function textureFixtureScenario(session: LiveSession): Promise<string> {
  await session.call("create_project", { name: "PBR MCP Release Smoke", format: "free" });
  const capabilities = await session.json("get_capabilities");
  session.check(record(record(capabilities.format).features).pbr === true, "test project supports PBR");
  const image = await session.call("create_texture", { name: names.color, width: 16, height: 16, fill_color: "#808080", layer_name: "Base" });
  const imageData = records(image.content).find(item => item.type === "image")?.data;
  session.check(typeof imageData === "string", "texture creation provides PNG fixture data");
  await Array.fromAsync(extraTextures, texture => session.call("create_texture", { ...texture, width: 16, height: 16, layer_name: "Base" }));
  await Array.fromAsync(invalidCreations, change => unchangedAfterError(session, change));
  return imageData;
}

async function creationScenario(session: LiveSession): Promise<string> {
  const created = await session.json("create_pbr_material", { name: MATERIAL_NAME, color_texture: names.color, normal_texture: names.normal, mer_value: [0, 0, 160] });
  const id = record(created.material).uuid;
  session.check(typeof id === "string", "material creation returns its UUID");
  const createdInfo = await material(session, id);
  session.check(channelNames(createdInfo).color === names.color && channelNames(createdInfo).normal === names.normal, "material contains requested color and normal maps");
  session.check(records((await session.exportProject()).texture_groups).some(group => group.uuid === id), "project export contains created material");
  await session.call("undo");
  const undoneCreation = await session.exportProject();
  session.check(!records(undoneCreation.texture_groups ?? []).some(group => group.uuid === id), "creation undo removes the material group");
  session.check(!exportedTexture(undoneCreation, names.color).group && !exportedTexture(undoneCreation, names.normal).group,
    "creation undo restores original texture membership");
  await session.call("redo");
  session.check(JSON.stringify(await material(session, id)) === JSON.stringify(createdInfo), "creation redo restores channels and material configuration");
  return id;
}

async function assignmentScenario(session: LiveSession, id: string): Promise<void> {
  await unchangedAfterError(session, {
    request: { name: "configure_material", arguments: { material: id, color_texture: "none", normal_texture: "__missing_texture__" } },
    label: "configure with a missing incoming texture",
  });
  await session.call("assign_texture_channel", { material: id, texture: names.replacement, channel: "color" });
  session.check(channelNames(await material(session, id)).color === names.replacement, "assignment replaces the color channel");
  session.check(!exportedTexture(await session.exportProject(), names.color).group, "assignment detaches the previous color map");
  await session.call("undo");
  session.check(channelNames(await material(session, id)).color === names.color, "assignment undo restores previous color map");
  session.check(!exportedTexture(await session.exportProject(), names.replacement).group, "assignment undo restores incoming texture membership");
  await session.call("redo");
  session.check(channelNames(await material(session, id)).color === names.replacement, "assignment redo restores replacement");
}

async function configureScenario(session: LiveSession, id: string): Promise<void> {
  await session.call("configure_material", { material: id, normal_texture: "none", height_texture: names.height, mer_value: [0, 0, 90] });
  const heightInfo = await material(session, id);
  session.check(channelNames(heightInfo).height === names.height && !channelNames(heightInfo).normal, "configure switches normal to height explicitly");
  const detachedNormal = exportedTexture(await session.exportProject(), names.normal);
  session.check(!detachedNormal.group && detachedNormal.pbr_channel === "normal", "displaced normal map retains its channel metadata");
  await session.call("undo");
  session.check(channelNames(await material(session, id)).normal === names.normal, "configure undo restores normal channel");
  session.check(JSON.stringify(record((await material(session, id)).config).mer_value) === "[0,0,160]", "configure undo restores uniform MER values");
  await session.call("redo");
  session.check(JSON.stringify(await material(session, id)) === JSON.stringify(heightInfo), "configure redo restores height and uniform MER values");
}

async function uniformScenario(session: LiveSession, id: string): Promise<Record<string, unknown>> {
  await session.call("assign_texture_channel", { material: id, texture: names.mer, channel: "mer" });
  session.check(channelNames(await material(session, id)).mer === names.mer, "MER image assignment works with a color map");
  await unchangedAfterError(session, {
    request: { name: "configure_material", arguments: { material: id, color_texture: "none", color_value: [128, 128, 128, 255] } },
    label: "removing color while MER remains",
  });
  await session.call("configure_material", { material: id, color_texture: "none", mer_texture: "none", color_value: [12, 34, 56, 255], mer_value: [0, 0, 200], subsurface_value: 32 });
  const uniform = await material(session, id);
  session.check(JSON.stringify(record(uniform.config).color_value) === "[12,34,56,255]" && record(uniform.config).subsurface_value === 32,
    "uniform color and subsurface values are applied");
  await session.call("undo");
  session.check(channelNames(await material(session, id)).mer === names.mer && channelNames(await material(session, id)).color === names.replacement,
    "uniform conversion undo restores both maps");
  await session.call("redo");
  session.check(JSON.stringify(await material(session, id)) === JSON.stringify(uniform), "uniform conversion redo restores configuration");
  return uniform;
}

async function groupedTextureScenario(session: LiveSession, id: string, uniform: Record<string, unknown>): Promise<void> {
  await session.call("create_texture", { name: "PBR Smoke Grouped Color", group: MATERIAL_NAME, pbr_channel: "color", width: 16, height: 16 });
  session.check(channelNames(await material(session, id)).color === "PBR Smoke Grouped Color", "create_texture resolves a material name and assigns the channel");
  await session.call("undo");
  session.check(JSON.stringify(await material(session, id)) === JSON.stringify(uniform), "grouped texture undo restores material configuration");
  session.check(!records((await session.exportProject()).textures).some(texture => texture.name === "PBR Smoke Grouped Color"), "grouped texture undo removes the new texture");
  await session.call("redo");
  session.check(channelNames(await material(session, id)).color === "PBR Smoke Grouped Color", "grouped texture redo restores its material channel");
}

async function previewScenario(session: LiveSession): Promise<void> {
  const created = { color: [10, 20, 30, 128], roughness: 40 };
  const configured = { color: [50, 60, 70, 255], roughness: 80 };
  const probe = await session.json("create_pbr_material", { name: "PBR Preview Probe", color_value: created.color, mer_value: [0, 0, created.roughness] });
  const probeId = record(probe.material).uuid;
  session.check(typeof probeId === "string", "preview probe returns a material UUID");
  await checkUniformPreview(session, probeId, created, "uniform creation");
  await session.call("configure_material", { material: probeId, color_value: configured.color, mer_value: [0, 0, configured.roughness] });
  await checkUniformPreview(session, probeId, configured, "uniform configure");
  await session.call("undo");
  await checkUniformPreview(session, probeId, created, "uniform undo");
  await session.call("redo");
  await checkUniformPreview(session, probeId, configured, "uniform redo");
}

function textureSet(channels: Record<string, string>): string {
  return JSON.stringify({ format_version: TEXTURE_SET_FORMAT_VERSION, "minecraft:texture_set": channels });
}

async function importScenario(session: LiveSession, imageData: string): Promise<void> {
  const png = Uint8Array.fromBase64(imageData);
  await Promise.all(FIXTURE_IMAGES.map(name => Bun.write(suiteArtifactPath("pbr", "fixtures", name), png)));
  const importPath = suiteArtifactPath("pbr", "fixtures", "smoke.texture_set.json");
  await Bun.write(importPath, textureSet({ color: "color", normal: "normal", metalness_emissive_roughness: "mer" }));
  const beforeImport = await session.exportProject();
  const imported = await session.json("import_texture_set", { path: importPath });
  const importedId = record(imported.material).uuid;
  session.check(typeof importedId === "string", "import returns the created material UUID");
  const importedInfo = await material(session, importedId);
  session.check(records(importedInfo.textures).length === FIXTURE_IMAGES.length, "import loads all three channel images");
  session.check(records((await session.exportProject()).textures).length === records(beforeImport.textures).length + FIXTURE_IMAGES.length,
    "import export contains three new textures");
  await session.call("undo");
  const undoneImport = await session.exportProject();
  session.check(records(undoneImport.textures).length === records(beforeImport.textures).length, "import undo removes all imported textures");
  session.check(!records(undoneImport.texture_groups ?? []).some(group => group.uuid === importedId), "import undo removes the material");
  await session.call("redo");
  session.check(JSON.stringify(await material(session, importedId)) === JSON.stringify(importedInfo), "import redo restores channels and metadata");
}

async function invalidImportScenario(session: LiveSession): Promise<void> {
  const invalidPath = suiteArtifactPath("pbr", "fixtures", "invalid.texture_set.json");
  const rejectImport = (label: string) => unchangedAfterError(session, { request: { name: "import_texture_set", arguments: { path: invalidPath } }, label });
  await Bun.write(invalidPath, textureSet({ color: "__missing_image__" }));
  await rejectImport("missing imported image");
  await Bun.write(suiteArtifactPath("pbr", "fixtures", "broken.png"), "not an image");
  await Bun.write(invalidPath, textureSet({ color: "broken" }));
  await rejectImport("corrupt imported image");
  await Bun.write(invalidPath, "{broken JSON");
  await rejectImport("invalid imported JSON");
}

async function pbrSuite(session: LiveSession): Promise<void> {
  const imageData = await textureFixtureScenario(session);
  const id = await creationScenario(session);
  await assignmentScenario(session, id);
  await configureScenario(session, id);
  const uniform = await uniformScenario(session, id);
  await groupedTextureScenario(session, id, uniform);
  await previewScenario(session);
  await importScenario(session, imageData);
  await invalidImportScenario(session);
  await session.writeResults("pbr");
  console.log(`Completed ${session.checks.length} PBR live checks.`);
}

await runLiveSuite("blockbench-pbr-smoke", pbrSuite);
