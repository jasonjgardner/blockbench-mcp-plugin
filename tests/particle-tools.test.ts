import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { join } from "node:path";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

/** A real 2x4 orange PNG. */
const PNG_2X4 = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAYAAACk7+45AAAAFklEQVR4nGP838Dwn4GBgYEJRGBnAABUcQKGuqbVnwAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

/** Wintersky config double: records what Blockbench would parse. */
interface IConfig {
  identifier?: string;
  file_path?: string;
  texture_source_category: string;
  preview_texture?: string;
  emitter_lifetime_mode?: string;
  updates: number;
  updateTexture(): void;
}

interface IDataPoint {
  effect?: string;
  file?: string;
  locator?: string;
  script?: string;
  bind_to_actor?: boolean;
}

class TestDataPoint implements IDataPoint {
  effect?: string;
  file?: string;
  locator?: string;
  script?: string;
  bind_to_actor?: boolean;
  constructor(readonly keyframe: TestFrame) {}
  extend(data: IDataPoint) {
    Object.assign(this, data);
  }
}

class TestFrame {
  uuid = crypto.randomUUID();
  time: number;
  channel: string;
  data_points: IDataPoint[];
  constructor(data: { time: number; channel: string; data_points: IDataPoint[] }, readonly animator: TestEffects) {
    this.time = data.time;
    this.channel = data.channel;
    this.data_points = data.data_points.map((point) => ({ ...point }));
  }
  remove() {
    this.animator.particle.splice(this.animator.particle.indexOf(this), 1);
  }
}

class TestEffects {
  particle: TestFrame[] = [];
  constructor(readonly animation: TestAnimation) {}
  addKeyframe(data: { time: number; channel: string; data_points: IDataPoint[] }) {
    const frame = new TestFrame(data, this);
    this.particle.push(frame);
    return frame;
  }
}

class TestAnimation {
  static all: TestAnimation[] = [];
  static selected: TestAnimation | null = null;
  uuid = crypto.randomUUID();
  animators: Record<string, TestEffects> = {};
  constructor(public name: string, public length: number) {}
}

class TestLocator {
  static all: TestLocator[] = [];
  uuid = crypto.randomUUID();
  name: string;
  position: number[];
  parent: unknown = null;
  constructor(data: { name: string; position: number[] }) {
    this.name = data.name;
    this.position = data.position;
  }
  addTo(parent: unknown) {
    this.parent = parent;
    return this;
  }
  init() {
    TestLocator.all.push(this);
    return this;
  }
}

let tools: IToolFixture;
let root: string;
let loaded: Record<string, { config: IConfig; emitters: Record<string, unknown> }>;
let previews = 0;
const head = { name: "head", uuid: "head-uuid" };

const undo = createUndoHost(
  {
    snapshot: ({ animations = [] }: { animations?: TestAnimation[] }) => animations.map((animation) => animation.animators.effects?.particle.length ?? 0),
    restore() {},
  },
);

const animator = {
  get particle_effects() {
    return loaded;
  },
  loadParticleEmitter(path: string, content: string) {
    const json = JSON.parse(content) as { particle_effect?: { description: { identifier: string; basic_render_parameters: { texture: string } }; components: Record<string, unknown> } };
    if (!json.particle_effect) return undefined;
    const description = json.particle_effect.description;
    const texture = description.basic_render_parameters.texture;
    const found = nodeFs.existsSync(join(root, ...`${texture}.png`.split("/")));
    const entry = loaded[path] ?? { config: { texture_source_category: "placeholder", updates: 0, updateTexture() { this.updates++; } }, emitters: {} };
    entry.config.identifier = description.identifier;
    entry.config.file_path = path;
    entry.config.emitter_lifetime_mode = "minecraft:emitter_lifetime_looping" in json.particle_effect.components ? "looping" : "once";
    entry.config.texture_source_category = texture.startsWith("textures/particle/particles") ? "built_in" : found ? "loaded" : "placeholder";
    loaded[path] = entry;
    return entry;
  },
  preview() {
    previews++;
  },
};

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/particle.ts"], register: ["registerParticleTools"] });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bb-particles-"));
  loaded = {};
  previews = 0;
  TestAnimation.all = [new TestAnimation("animation.idle", 2)];
  TestAnimation.selected = TestAnimation.all[0] ?? null;
  TestLocator.all = [];
  undo.reset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

useGlobals(() => ({
  Animation: TestAnimation,
  Animator: animator,
  Canvas: { updateAll() {} },
  EffectAnimator: TestEffects,
  Format: { animation_mode: true, locators: true },
  Group: { all: [head] },
  KeyframeDataPoint: TestDataPoint,
  Locator: TestLocator,
  Project: { save_path: join(root, "model.bbmodel") },
  Undo: undo,
  isApp: true,
  requireNativeModule: (name: string) => (name === "fs" ? nodeFs : nodePath),
}));

async function callJson(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = CallToolResultSchema.parse(await tools.call(name, input));
  const text = result.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") throw new Error(`${name} returned no text`);
  return JSON.parse(text.text) as Record<string, unknown>;
}

test("list_particle_presets describes presets, sprites and units", async () => {
  const result = await callJson("list_particle_presets", { include_designs: false });
  const presets = result.presets as { name: string; design?: unknown }[];
  expect(presets.map((preset) => preset.name)).toContain("smoke");
  expect(presets.every((preset) => preset.design === undefined)).toBe(true);
  expect(String(result.units)).toContain("16 model units");
});

test("create_particle_effect writes a preset into the project's particles folder and loads it", async () => {
  const result = await callJson("create_particle_effect", { identifier: "test:chimney", preset: "smoke", design: { rate: 3 } });
  const file = join(root, "particles", "chimney.json");
  expect(result.file).toBe(file);
  expect(result.effect_name).toBe("chimney");
  const json = JSON.parse(readFileSync(file, "utf8"));
  expect(json.particle_effect.components["minecraft:emitter_rate_steady"].spawn_rate).toBe(3);
  expect(loaded[file]?.config.identifier).toBe("test:chimney");
  expect(loaded[file]?.config.updates).toBe(1);
  expect(result.texture).toBe("built-in texture");
});

test("create_particle_effect refuses to overwrite and refuses invalid effects before writing", async () => {
  await callJson("create_particle_effect", { identifier: "test:a", preset: "flame" });
  await expect(tools.call("create_particle_effect", { identifier: "test:a", preset: "flame" })).rejects.toThrow("already exists");
  await expect(tools.call("create_particle_effect", { identifier: "test:b", design: { components: { "minecraft:particle_appearance_billboard": null } } })).rejects.toThrow("invisible");
  expect(nodeFs.existsSync(join(root, "particles", "b.json"))).toBe(false);
});

test("a custom texture image is copied into textures/particle and sized from the PNG", async () => {
  const png = join(root, "leaf-source.png");
  writeFileSync(png, PNG_2X4);
  const result = await callJson("create_particle_effect", { identifier: "test:leaf", design: { rate: 2 }, texture_image: { path: png } });
  const json = JSON.parse(readFileSync(join(root, "particles", "leaf.json"), "utf8"));
  expect(json.particle_effect.description.basic_render_parameters.texture).toBe("textures/particle/leaf");
  expect(json.particle_effect.components["minecraft:particle_appearance_billboard"].uv).toEqual({ texture_width: 2, texture_height: 4, uv: [0, 0], uv_size: [2, 4] });
  expect(result.texture_file).toBe(join(root, "textures", "particle", "leaf.png"));
  expect(result.texture).toBe("custom texture found");
});

test("update_particle_effect patches only the knob's components and reloads", async () => {
  await callJson("create_particle_effect", { identifier: "test:fx", preset: "bubbles" });
  const file = join(root, "particles", "fx.json");
  const before = JSON.parse(readFileSync(file, "utf8"));
  await callJson("update_particle_effect", { effect: "fx", design: { lifetime: 5 } });
  const after = JSON.parse(readFileSync(file, "utf8"));
  expect(after.particle_effect.components["minecraft:particle_lifetime_expression"]).toEqual({ max_lifetime: 5 });
  expect(after.particle_effect.components["minecraft:particle_motion_dynamic"]).toEqual(before.particle_effect.components["minecraft:particle_motion_dynamic"]);
  expect(loaded[file]?.config.updates).toBe(2);
});

test("update refuses to replace a different texture PNG unless overwrite is set", async () => {
  const png = join(root, "leaf-source.png");
  writeFileSync(png, PNG_2X4);
  await callJson("create_particle_effect", { identifier: "test:leaf", design: { rate: 2 }, texture_image: { path: png } });
  const other = join(root, "other.png");
  writeFileSync(other, Uint8Array.from([...PNG_2X4.slice(0, 40), 1, ...PNG_2X4.slice(41)]));
  await expect(tools.call("update_particle_effect", { effect: "test:leaf", texture_image: { path: other } })).rejects.toThrow("already exists");
  await callJson("update_particle_effect", { effect: "test:leaf", texture_image: { path: other }, overwrite: true });
  expect(readFileSync(join(root, "textures", "particle", "leaf.png"))[40]).toBe(1);
});

test("a short name shared by two identifiers is refused instead of guessed", async () => {
  await callJson("create_particle_effect", { identifier: "a:smoke", preset: "smoke", pack_root: join(root, "A") });
  await callJson("create_particle_effect", { identifier: "b:smoke", preset: "smoke", pack_root: join(root, "B") });
  await expect(tools.call("update_particle_effect", { effect: "smoke", design: { rate: 3 } })).rejects.toThrow("a:smoke and b:smoke");
  await callJson("update_particle_effect", { effect: "b:smoke", design: { rate: 3 } });
  expect(JSON.parse(readFileSync(join(root, "B", "particles", "smoke.json"), "utf8")).particle_effect.components["minecraft:emitter_rate_steady"].spawn_rate).toBe(3);
});

test("update with raw keeps the effect's identifier", async () => {
  await callJson("create_particle_effect", { identifier: "test:fx", preset: "flame" });
  const raw = JSON.parse(readFileSync(join(root, "particles", "fx.json"), "utf8"));
  raw.particle_effect.description.identifier = "other:thing";
  const result = await callJson("update_particle_effect", { effect: "test:fx", raw });
  expect(result.identifier).toBe("test:fx");
});

test("keyframes attach the loaded file, reject missing locators and merge same-time effects", async () => {
  await callJson("create_particle_effect", { identifier: "test:smoke", preset: "smoke" });
  await callJson("add_locator", { name: "mouth", parent: "head", position: [0, 20, -4] });
  await expect(tools.call("manage_particle_keyframes", { action: "add", keyframes: [{ time: 0, effect: "smoke", locator: "nose" }] })).rejects.toThrow("Locator nose not found");
  const added = await callJson("manage_particle_keyframes", { action: "add", keyframes: [{ time: 0.5, effect: "test:smoke", locator: "mouth" }, { time: 0.5, effect: "flame_handler" }] });
  const frames = TestAnimation.all[0]?.animators.effects?.particle ?? [];
  expect(frames).toHaveLength(1);
  expect(frames[0]?.data_points.map((point) => [point.effect, point.file, point.locator])).toEqual([
    ["smoke", join(root, "particles", "smoke.json"), "mouth"],
    ["flame_handler", "", ""],
  ]);
  expect(String((added.warnings as string[])[0])).toContain("flame_handler");
  expect(String((added.warnings as string[])[1])).toContain("looping: false and duration 2");
  expect(previews).toBeGreaterThan(0);
  await expect(tools.call("manage_particle_keyframes", { action: "add", keyframes: [{ time: 3, effect: "smoke" }] })).rejects.toThrow("past the animation length");
});

test("remove drops matching effects and whole keyframes", async () => {
  await callJson("create_particle_effect", { identifier: "test:smoke", preset: "smoke" });
  await callJson("manage_particle_keyframes", { action: "add", keyframes: [{ time: 0, effect: "smoke" }, { time: 0, effect: "other" }, { time: 1, effect: "smoke" }] });
  const partial = await callJson("manage_particle_keyframes", { action: "remove", times: [0], effect_filter: "test:smoke" });
  expect(partial.removed).toBe(1);
  const all = await callJson("manage_particle_keyframes", { action: "remove" });
  expect(all.removed).toBe(2);
  expect(TestAnimation.all[0]?.animators.effects?.particle).toEqual([]);
});

test("list_particle_effects reports usages, unpreviewable keyframes and the client entity map", async () => {
  await callJson("create_particle_effect", { identifier: "test:smoke", preset: "smoke" });
  await callJson("manage_particle_keyframes", { action: "add", keyframes: [{ time: 0, effect: "smoke", effect_name: "chimney_smoke" }, { time: 1, effect: "mystery" }] });
  const result = await callJson("list_particle_effects", {});
  const effects = result.effects as { used_by: unknown[] }[];
  expect(effects[0]?.used_by).toHaveLength(1);
  expect(result.client_entity).toEqual({ particle_effects: { chimney_smoke: "test:smoke" } });
  expect((result.problems as string[]).join(" ")).toContain('effect "mystery" has no particle file');
});

test("add_locator requires unique names and known parents", async () => {
  await callJson("add_locator", { name: "tip", position: [0, 1, 0] });
  await expect(tools.call("add_locator", { name: "tip", position: [0, 1, 0] })).rejects.toThrow("already exists");
  await expect(tools.call("add_locator", { name: "tail", parent: "tail_bone", position: [0, 1, 0] })).rejects.toThrow('"tail_bone" not found');
  expect(TestLocator.all.map((locator) => locator.name)).toEqual(["tip"]);
});

test("export_particle_pack writes used effects and custom textures, then skips identical files", async () => {
  const png = join(root, "spark.png");
  writeFileSync(png, PNG_2X4);
  await callJson("create_particle_effect", { identifier: "test:spark", preset: "sparks", texture_image: { path: png } });
  await callJson("manage_particle_keyframes", { action: "add", keyframes: [{ time: 0, effect: "spark" }] });
  const pack = join(root, "RP");
  const first = await callJson("export_particle_pack", { destination: pack });
  expect(first.written).toEqual([join(pack, "particles", "spark.json"), join(pack, "textures", "particle", "spark.png")]);
  expect(first.client_entity).toEqual({ particle_effects: { spark: "test:spark" } });
  const second = await callJson("export_particle_pack", { destination: pack });
  expect(second.written).toEqual([]);
  writeFileSync(join(pack, "particles", "spark.json"), "{}");
  await expect(tools.call("export_particle_pack", { destination: pack })).rejects.toThrow("different content");
});

test("export leaves an effect that already lives in the destination pack alone", async () => {
  const pack = join(root, "RP");
  await callJson("create_particle_effect", { identifier: "test:smoke", preset: "smoke", pack_root: pack });
  await callJson("manage_particle_keyframes", { action: "add", keyframes: [{ time: 0, effect: "smoke" }] });
  const result = await callJson("export_particle_pack", { destination: pack });
  expect(result.written).toEqual([]);
  expect(result.already_in_pack).toEqual([join(pack, "particles", "smoke.json")]);
});
