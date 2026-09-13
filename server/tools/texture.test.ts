import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { win32 } from "node:path";
import { registerTextureTools } from "@/server/tools/texture";
import { required } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import type { IMaterialUniforms, PbrChannel } from "@/tests/helpers/shapes";
import { executeTool } from "@/tests/helpers/tool-execution";
import { createUndoHost } from "@/tests/helpers/undo-host";

/** Material config fields snapshotted by undo. */
interface IConfig extends IMaterialUniforms {
  subsurface_value: number;
  saved: boolean;
}

/** Live `material_config`: snapshotted fields plus the host methods tools call. */
interface IMaterialConfig extends IConfig {
  getFilePath(): string;
  compileForBedrock(): unknown;
  save(): void;
}

interface ITextureData {
  name: string;
  group?: string;
  pbr_channel?: PbrChannel;
}

interface ITextureExtension {
  group: string;
  pbr_channel?: PbrChannel;
}

interface IGroupData {
  name?: string;
  is_material?: boolean;
}

/** Texture and group lists, shaped like both `Project` and the undo aspects tools pass to `Undo.initEdit`. */
interface ITextureCollections {
  textures: TestTexture[];
  texture_groups: TestGroup[];
}

interface ITextureSnapshot {
  texture: TestTexture;
  group: string;
  channel: PbrChannel;
  name: string;
}

interface IGroupSnapshot {
  group: TestGroup;
  config: IConfig;
}

interface ISnapshot {
  textures: ITextureSnapshot[];
  groups: IGroupSnapshot[];
}

const TRANSPARENT_PNG_DATA_URL = "data:image/png;base64,AA==";

let sequence = 0;
let failPreview = false;
let failAdd = false;
let project: ITextureCollections;
let files = new Map<string, string>();

class TestTexture {
  static get all(): TestTexture[] {
    return project.textures;
  }
  uuid = `texture-${++sequence}`;
  id = this.uuid;
  name: string;
  group: string;
  pbr_channel: PbrChannel;
  path = "";
  width = 16;
  height = 16;
  render_mode = "default";
  render_sides = "auto";
  constructor(data: ITextureData) {
    this.name = data.name;
    this.group = data.group ?? "";
    this.pbr_channel = data.pbr_channel ?? "color";
  }
  add(): this {
    project.textures.push(this);
    return this;
  }
  getActiveCanvas() {
    return { ctx: { clearRect() {}, canvas: { toDataURL: () => TRANSPARENT_PNG_DATA_URL } } };
  }
  updateSource(): void {}
  updateLayerChanges(): void {}
  updateMaterial(): void {}
  getDataURL(): string {
    return TRANSPARENT_PNG_DATA_URL;
  }
  extend(data: ITextureExtension): this {
    this.group = data.group;
    if (data.pbr_channel) this.pbr_channel = data.pbr_channel;
    return this;
  }
}

class TestGroup {
  static get all(): TestGroup[] {
    return project.texture_groups;
  }
  uuid = `group-${++sequence}`;
  name: string;
  is_material: boolean;
  material_config: IMaterialConfig;
  constructor(data: IGroupData) {
    this.name = data.name ?? "Material";
    this.is_material = data.is_material ?? false;
    this.material_config = {
      color_value: [255, 255, 255, 255],
      mer_value: [0, 0, 0],
      subsurface_value: 0,
      saved: true,
      getFilePath: () => {
        const color = this.getTextures().find(texture => texture.pbr_channel === "color");
        return color ? color.path.replace(/\.\w+$/, "") + ".texture_set.json" : "";
      },
      compileForBedrock: () => ({ "minecraft:texture_set": { color: this.material_config.color_value } }),
      save: () => {
        files.set(this.material_config.getFilePath(), "{}");
        this.material_config.saved = true;
      },
    };
  }
  add(): this {
    project.texture_groups.push(this);
    if (failAdd) throw new Error("Group preview initialization failed");
    return this;
  }
  getTextures(): TestTexture[] {
    return project.textures.filter(texture => texture.group === this.uuid);
  }
  updateMaterial(): void {
    if (failPreview) throw new Error("Material preview failed");
  }
}

function configSnapshot(group: TestGroup): IConfig {
  const { color_value, mer_value, subsurface_value, saved } = group.material_config;
  return structuredClone({ color_value, mer_value, subsurface_value, saved });
}

function snapshot(aspects: ITextureCollections): ISnapshot {
  return {
    textures: aspects.textures.map(texture => ({ texture, group: texture.group, channel: texture.pbr_channel, name: texture.name })),
    groups: aspects.texture_groups.map(group => ({ group, config: configSnapshot(group) })),
  };
}

/** Keeps an entity unless the replaced state (`reference`) tracked it and the restored state (`target`) does not. */
function survivesRestore<T>(item: T, target: readonly T[], reference: readonly T[]): boolean {
  return !reference.includes(item) || target.includes(item);
}

function restore(target: ISnapshot, reference: ISnapshot): void {
  const targetTextures = target.textures.map(entry => entry.texture);
  const referenceTextures = reference.textures.map(entry => entry.texture);
  const targetGroups = target.groups.map(entry => entry.group);
  const referenceGroups = reference.groups.map(entry => entry.group);
  project.textures = project.textures.filter(texture => survivesRestore(texture, targetTextures, referenceTextures));
  project.texture_groups = project.texture_groups.filter(group => survivesRestore(group, targetGroups, referenceGroups));
  target.groups.forEach(({ group, config }) => {
    if (!project.texture_groups.includes(group)) project.texture_groups.push(group);
    Object.assign(group.material_config, structuredClone(config));
  });
  target.textures.forEach(({ texture, group, channel, name }) => {
    if (!project.textures.includes(texture)) project.textures.push(texture);
    Object.assign(texture, { group, pbr_channel: channel, name });
  });
}

const undo = createUndoHost({ restore, snapshot });

function requireNativeModule(name: string): unknown {
  if (name === "path") return win32;
  return {
    existsSync: (path: string) => files.has(path),
    statSync: () => ({ isFile: () => true }),
    readFileSync: (path: string) => files.get(path),
  };
}

beforeAll(() => registerTextureTools());
beforeEach(() => {
  sequence = 0;
  failPreview = false;
  failAdd = false;
  project = { textures: [], texture_groups: [] };
  files = new Map();
  undo.reset();
});
useGlobals(() => ({
  Blockbench: { isWeb: false },
  Canvas: { updateAll() {} },
  Format: { id: "free", pbr: true },
  Project: project,
  Texture: TestTexture,
  TextureGroup: TestGroup,
  Undo: undo,
  requireNativeModule,
}));

function texture(name: string, group = "", channel: PbrChannel = "color"): TestTexture {
  return new TestTexture({ name, group, pbr_channel: channel }).add();
}

function material(name: string): TestGroup {
  return new TestGroup({ name, is_material: true }).add();
}

function state(): string {
  return JSON.stringify({
    textures: project.textures.map(item => ({ uuid: item.uuid, group: item.group, channel: item.pbr_channel })),
    groups: project.texture_groups.map(group => ({ uuid: group.uuid, config: configSnapshot(group) })),
    history: undo.history.length,
    index: undo.index,
  });
}

interface IUnassignedMaps {
  color: TestTexture;
  normal: TestTexture;
  mer: TestTexture;
}

interface IInvalidMaterialCase {
  label: string;
  /** Built per test because texture UUIDs come from the maps created inside that test. */
  args(maps: IUnassignedMaps): Record<string, unknown>;
  error: RegExp;
}

const invalidMaterialCases: IInvalidMaterialCase[] = [
  {
    label: "the same texture in two channels",
    args: ({ color }) => ({ name: "Duplicate", color_texture: color.uuid, normal_texture: "Albedo" }),
    error: /A texture can occupy only one PBR channel/,
  },
  {
    label: "normal and height maps together",
    args: ({ normal, color }) => ({ name: "Depth", normal_texture: normal.uuid, height_texture: color.uuid }),
    error: /Use either normal_texture or height_texture, not both/,
  },
  {
    label: "a MER map without a color map",
    args: ({ mer }) => ({ name: "MER-only", mer_texture: mer.uuid, color_value: [255, 255, 255, 255] }),
    error: /Material "MER-only" needs a color texture when using a MER texture/,
  },
  {
    label: "a uniform color hidden by a color map",
    args: ({ color }) => ({ name: "Ignored uniform", color_texture: color.uuid, color_value: [255, 0, 0, 255] }),
    error: /color_value requires no color texture/,
  },
];

interface IInvalidTextureSetCase {
  label: string;
  contents: string;
  error: RegExp;
}

const INVALID_TEXTURE_SET_PATH = "C:\\textures\\test.texture_set.json";

const invalidTextureSetCases: IInvalidTextureSetCase[] = [
  {
    label: "an empty object",
    contents: JSON.stringify({}),
    error: /Invalid texture set: format_version: Required; minecraft:texture_set: Required/,
  },
  {
    label: "normal and heightmap layers together",
    contents: JSON.stringify({ format_version: "1.16.100", "minecraft:texture_set": { color: [1, 2, 3, 255], normal: "n", heightmap: "h" } }),
    error: /Invalid texture set: minecraft:texture_set: Normal and heightmap layers cannot coexist\./,
  },
  {
    label: "MER and MERS layers together",
    contents: JSON.stringify({ format_version: "1.21.30", "minecraft:texture_set": { color: [1, 2, 3, 255], metalness_emissive_roughness: [0, 0, 0], metalness_emissive_roughness_subsurface: [0, 0, 0, 1] } }),
    error: /Invalid texture set: minecraft:texture_set: MER and MERS layers cannot coexist\./,
  },
  {
    label: "a missing color image",
    contents: JSON.stringify({ format_version: "1.16.100", "minecraft:texture_set": { color: "missing" } }),
    error: /Missing color image "missing" referenced by ".*test\.texture_set\.json"/,
  },
  {
    label: "malformed JSON",
    contents: "{invalid json",
    error: /Invalid JSON in ".*test\.texture_set\.json"/,
  },
];

describe("PBR material transactions", () => {
  test("create_texture resolves material names and restores displaced maps on undo", async () => {
    const group = material("Material");
    const old = texture("old normal", group.uuid, "normal");
    await executeTool("create_texture", { name: "new normal", group: "Material", pbr_channel: "normal" });
    const created = project.textures.find(item => item.name === "new normal");
    expect(created?.group).toBe(group.uuid);
    expect(old.group).toBe("");
    expect(old.pbr_channel).toBe("normal");
    undo.undo();
    expect(project.textures.map(item => item.name)).toEqual(["old normal"]);
    expect(old.group).toBe(group.uuid);
    undo.redo();
    expect(project.textures.find(item => item.name === "new normal")?.group).toBe(group.uuid);
  });

  test("create_texture rejects missing groups and a MER-only result without state changes", async () => {
    const group = material("Empty");
    const before = state();
    await expect(executeTool("create_texture", { name: "Missing", group: "missing" })).rejects.toThrow(/Material\/texture group "missing" not found/);
    await expect(executeTool("create_texture", { name: "MER", group: group.uuid, pbr_channel: "mer" })).rejects.toThrow("needs a color texture");
    expect(state()).toBe(before);
    expect(undo.starts).toBe(0);
  });

  test("rejects every invalid group texture before creating a group or undo entry", async () => {
    texture("valid");
    const before = state();
    await expect(executeTool("add_texture_group", { name: "invalid", textures: ["valid", "missing"] })).rejects.toThrow(/Texture "missing" not found/);
    expect(state()).toBe(before);
    expect(undo.starts).toBe(0);
  });

  test("undo and redo group creation and membership together", async () => {
    const first = texture("first");
    const second = texture("second");
    await executeTool("add_texture_group", { name: "Images", textures: [first.uuid, second.uuid], is_material: false });
    const groupId = required(project.texture_groups.at(0), "Images group").uuid;
    expect([first.group, second.group]).toEqual([groupId, groupId]);
    undo.undo();
    expect(project.texture_groups).toHaveLength(0);
    expect([first.group, second.group]).toEqual(["", ""]);
    undo.redo();
    expect(project.texture_groups[0].uuid).toBe(groupId);
    expect([first.group, second.group]).toEqual([groupId, groupId]);
  });

  test("creation undo removes the material and restores source membership and saved config", async () => {
    const source = material("Source");
    const color = texture("Albedo", source.uuid);
    const normal = texture("Normal", source.uuid, "normal");
    await executeTool("create_pbr_material", { name: "Target", color_texture: color.uuid, normal_texture: normal.uuid, mer_value: [0, 10, 80], subsurface_value: 4 });
    const target = required(project.texture_groups.find(group => group.name === "Target"), "Target material");
    expect(target.material_config.mer_value).toEqual([0, 10, 80]);
    expect(target.material_config.subsurface_value).toBe(4);
    expect(source.material_config.saved).toBe(false);
    undo.undo();
    expect(project.texture_groups.map(group => group.name)).toEqual(["Source"]);
    expect([color.group, normal.group]).toEqual([source.uuid, source.uuid]);
    expect(source.material_config.saved).toBe(true);
    undo.redo();
    expect(project.texture_groups).toHaveLength(2);
    expect(color.group).toBe(target.uuid);
    expect(target.material_config.saved).toBe(false);
  });

  test.each(invalidMaterialCases)("create_pbr_material rejects $label without editing", async ({ args, error }) => {
    const maps: IUnassignedMaps = { color: texture("Albedo"), normal: texture("Normal"), mer: texture("MER") };
    const before = state();
    await expect(executeTool("create_pbr_material", args(maps))).rejects.toThrow(error);
    expect(state()).toBe(before);
    expect(undo.starts).toBe(0);
  });

  test("configure resolves incoming references before clearing existing maps", async () => {
    const group = material("Material");
    texture("Albedo", group.uuid);
    const before = state();
    await expect(executeTool("configure_material", { material: group.uuid, color_texture: "none", normal_texture: "missing" })).rejects.toThrow(/Texture "missing" not found/);
    expect(state()).toBe(before);
    expect(undo.starts).toBe(0);
  });

  test("replacement snapshots incoming and displaced textures and both groups", async () => {
    const destination = material("Destination");
    const source = material("Source");
    const old = texture("old", destination.uuid);
    const incoming = texture("incoming", source.uuid);
    await executeTool("assign_texture_channel", { material: destination.uuid, texture: incoming.uuid, channel: "color" });
    expect(old.group).toBe("");
    expect(old.pbr_channel).toBe("color");
    expect(incoming.group).toBe(destination.uuid);
    expect(source.material_config.saved).toBe(false);
    undo.undo();
    expect(old.group).toBe(destination.uuid);
    expect(incoming.group).toBe(source.uuid);
    expect(source.material_config.saved).toBe(true);
    undo.redo();
    expect(destination.getTextures().map(item => item.uuid)).toEqual([incoming.uuid]);
  });

  test("normal replacement preserves the old map channel and round-trips uniforms", async () => {
    const group = material("Material");
    const old = texture("old normal", group.uuid, "normal");
    const replacement = texture("height");
    await executeTool("configure_material", { material: group.uuid, normal_texture: "none", height_texture: replacement.uuid, color_value: [12, 34, 56, 255], mer_value: [0, 0, 170] });
    expect(old.group).toBe("");
    expect(old.pbr_channel).toBe("normal");
    expect(replacement.pbr_channel).toBe("height");
    expect(group.material_config.color_value).toEqual([12, 34, 56, 255]);
    undo.undo();
    expect(old.group).toBe(group.uuid);
    expect(replacement.group).toBe("");
    expect(replacement.pbr_channel).toBe("color");
    expect(group.material_config.color_value).toEqual([255, 255, 255, 255]);
    undo.redo();
    expect(group.material_config.mer_value).toEqual([0, 0, 170]);
  });

  test("does not orphan a source MER map or silently ignore a uniform value", async () => {
    const source = material("Source");
    const target = material("Target");
    const color = texture("Albedo", source.uuid);
    texture("MER", source.uuid, "mer");
    const before = state();
    await expect(executeTool("assign_texture_channel", { material: target.uuid, texture: color.uuid, channel: "color" })).rejects.toThrow("needs a color texture");
    await expect(executeTool("configure_material", { material: source.uuid, mer_value: [0, 0, 0] })).rejects.toThrow("Set mer_texture to 'none'");
    expect(state()).toBe(before);
  });

  test("rolls back a failed material preview with no pending edit or history", async () => {
    const group = material("Material");
    const old = texture("old", group.uuid);
    const replacement = texture("new");
    const before = state();
    failPreview = true;
    await expect(executeTool("configure_material", { material: group.uuid, color_texture: replacement.uuid })).rejects.toThrow("preview failed");
    expect(state()).toBe(before);
    expect(undo.pending).toBeUndefined();
    expect(old.group).toBe(group.uuid);
  });

  test("rolls back failure while adding a newly created group", async () => {
    const before = state();
    failAdd = true;
    await expect(executeTool("create_pbr_material", { name: "Failed", color_value: [10, 20, 30, 255] })).rejects.toThrow("initialization failed");
    expect(state()).toBe(before);
    expect(undo.pending).toBeUndefined();
  });

  test("rejects ordinary groups, unsupported formats, and missing projects", async () => {
    const group = new TestGroup({ name: "Ordinary" }).add();
    await expect(executeTool("configure_material", { material: group.uuid, color_value: [0, 0, 0, 255] })).rejects.toThrow("not a PBR material");
    Object.assign(globalThis, { Format: { pbr: false } });
    await expect(executeTool("create_pbr_material", { name: "Unsupported" })).rejects.toThrow("does not support PBR");
    Object.assign(globalThis, { Project: null });
    await expect(executeTool("create_pbr_material", { name: "No project" })).rejects.toThrow("Open a project");
    expect(undo.starts).toBe(0);
  });

  test.each(invalidTextureSetCases)("import_texture_set rejects $label before undo", async ({ contents, error }) => {
    const before = state();
    files.set(INVALID_TEXTURE_SET_PATH, contents);
    await expect(executeTool("import_texture_set", { path: INVALID_TEXTURE_SET_PATH })).rejects.toThrow(error);
    expect(state()).toBe(before);
    expect(undo.starts).toBe(0);
  });

  test("uniform texture-set import is one reversible edit with correct ARGB/MERS conversion", async () => {
    const path = "C:\\textures\\uniform.texture_set.json";
    files.set(path, JSON.stringify({ format_version: "1.21.30", "minecraft:texture_set": { color: "#80102030", metalness_emissive_roughness_subsurface: [0, 2, 100, 64] } }));
    await executeTool("import_texture_set", { path });
    const group = required(project.texture_groups.at(0), "imported material");
    expect(group.material_config.color_value).toEqual([16, 32, 48, 128]);
    expect(group.material_config.mer_value).toEqual([0, 2, 100]);
    expect(group.material_config.subsurface_value).toBe(64);
    expect(group.material_config.saved).toBe(true);
    expect(undo.history).toHaveLength(1);
    undo.undo();
    expect(project.texture_groups).toHaveLength(0);
    undo.redo();
    expect(project.texture_groups[0].uuid).toBe(group.uuid);
    expect(project.texture_groups[0].material_config.subsurface_value).toBe(64);
  });

  test("does not save relative to cwd when the color image has no file path", async () => {
    const group = material("Unsaved");
    texture("Albedo", group.uuid);
    await expect(executeTool("save_material_config", { material: group.uuid })).rejects.toThrow("valid file path");
    expect(files.size).toBe(0);
  });
});
