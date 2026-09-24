import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ModelStore } from "./document/store";
import { applyOperations, operationSchema } from "./edit/operations";
import { EFFECTS_ANIMATOR_KEY } from "./edit/particle-operations";
import { compileBedrockGeometry } from "./formats/bedrock";
import { BbRenderer } from "./render/bb-render";
import { createHeadlessServer } from "./server";
import { creatureModel } from "./test-fixtures";

/** A real 2x4 orange PNG. */
const PNG_2X4 = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAYAAACk7+45AAAAFklEQVR4nGP838Dwn4GBgYEJRGBnAABUcQKGuqbVnwAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

const apply = (ops: unknown[], doc = creatureModel(true)) => applyOperations(doc, operationSchema.array().parse(ops));

describe("particle edit operations", () => {
  test("add_locator saves a locator element under its group", () => {
    const { doc, results } = apply([{ op: "add_locator", name: "mouth", parent: "head", position: [0, 10, -11] }]);
    const locator = doc.elements.find((element) => element.type === "locator");
    expect(locator).toMatchObject({ name: "mouth", position: [0, 10, -11], rotation: [0, 0, 0], type: "locator", uuid: results[0]?.uuid });
    expect(() => apply([{ op: "add_locator", name: "mouth", position: [0, 0, 0] }], doc)).toThrow("already exists");
  });

  test("set_particle_keyframe writes the Effects track Blockbench loads and merges effects at one time", () => {
    const { doc } = apply([
      { op: "add_locator", name: "mouth", parent: "head", position: [0, 10, -11] },
      { op: "set_particle_keyframe", animation: "animation.creature.walk", time: 0.5, effect: "smoke", file: "particles/smoke.json", locator: "mouth" },
      { op: "set_particle_keyframe", animation: "animation.creature.walk", time: 0.5, effect: "spark" },
      { op: "set_particle_keyframe", animation: "animation.creature.walk", time: 0.5, effect: "smoke", file: "particles/smoke2.json", locator: "mouth" },
    ]);
    const track = doc.animations?.[0]?.animators[EFFECTS_ANIMATOR_KEY];
    expect(track).toMatchObject({ name: "Effects", type: "effect" });
    expect(track?.keyframes).toHaveLength(1);
    expect(track?.keyframes[0]).toMatchObject({ channel: "particle", time: 0.5 });
    expect(track?.keyframes[0]?.data_points).toEqual([
      { effect: "spark", locator: "", script: "", file: "", bind_to_actor: true },
      { effect: "smoke", locator: "mouth", script: "", file: "particles/smoke2.json", bind_to_actor: true },
    ]);
  });

  test("set_particle_keyframe rejects unknown locators; remove drops effects and empty keyframes", () => {
    expect(() => apply([{ op: "set_particle_keyframe", animation: "animation.creature.walk", time: 0, effect: "smoke", locator: "nose" }])).toThrow("Locator nose not found");
    const { doc } = apply([
      { op: "set_particle_keyframe", animation: "animation.creature.walk", time: 0, effect: "smoke" },
      { op: "set_particle_keyframe", animation: "animation.creature.walk", time: 0, effect: "spark" },
      { op: "remove_particle_keyframe", animation: "animation.creature.walk", time: 0, effect: "spark" },
    ]);
    expect(doc.animations?.[0]?.animators[EFFECTS_ANIMATOR_KEY]?.keyframes[0]?.data_points.map((point) => point.effect)).toEqual(["smoke"]);
    const cleared = apply([{ op: "remove_particle_keyframe", animation: "animation.creature.walk", time: 0 }], doc).doc;
    expect(cleared.animations?.[0]?.animators[EFFECTS_ANIMATOR_KEY]?.keyframes).toEqual([]);
    expect(() => apply([{ op: "remove_particle_keyframe", animation: "animation.creature.walk", time: 3 }], cleared)).toThrow("No particle effect");
  });

  test("Bedrock geometry exports locators like Blockbench", () => {
    const { doc } = apply([
      { op: "add_locator", name: "mouth", parent: "head", position: [1, 10, -11] },
      { op: "add_locator", name: "tail_tip", parent: "body", position: [2, 8, 7], rotation: [10, 20, 30] },
      { op: "add_locator", name: "root_marker", position: [0, 0, 0], ignore_inherited_scale: true },
    ]);
    const { geometry, skipped } = compileBedrockGeometry(doc);
    const bones = (geometry["minecraft:geometry"] as { bones: { name: string; locators?: Record<string, unknown> }[] }[])[0]?.bones ?? [];
    expect(skipped).toEqual([]);
    expect(bones.find((bone) => bone.name === "head")?.locators).toEqual({ mouth: [-1, 10, -11] });
    expect(bones.find((bone) => bone.name === "body")?.locators).toEqual({ tail_tip: { offset: [-2, 8, 7], rotation: [-10, -20, 30] } });
    expect(bones.find((bone) => bone.name === "bb_main")?.locators).toEqual({ root_marker: { offset: [-0, 0, 0], rotation: [-0, -0, 0], ignore_inherited_scale: true } });
  });
});

describe("particle tools", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-headless-particles-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function connect(): Promise<<T = Record<string, unknown>>(name: string, args: Record<string, unknown>) => Promise<T>> {
    const store = new ModelStore({ roots: [root] });
    const server = createHeadlessServer(() => ({
      store,
      renderer: new BbRenderer({ node: "node", concurrency: 1, timeoutMs: 1000, prepare: () => Promise.reject(new Error("runtime disabled in tests")) }),
      scratchDir: join(root, "renders"),
      aiDisclosure: false,
      clientName: () => "particle-test",
      webApp: { enabled: false, baseUrl: "https://web.blockbench.net/", inlineMax: 8000, browserMax: 2_000_000, launcherDir: join(root, "renders", "web-app") },
      desktop: { executable: process.execPath, mcpUrl: "http://127.0.0.1:9/bb-mcp" },
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "particle-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      if (result.isError) throw new Error(text);
      return JSON.parse(text) as T;
    };
  }

  test("author an effect, place it on a model, and pack it", async () => {
    const call = await connect();
    await Bun.write(join(root, "models", "creature.bbmodel"), JSON.stringify(creatureModel(true)));
    await Bun.write(join(root, "art", "ember.png"), PNG_2X4);
    const effect = await call<{ file: string; keyframe_file: string; effect_name: string; texture_file: string }>("bbmodel_particle_effect", {
      identifier: "test:ember",
      preset: "embers",
      design: { looping: false, duration: 1 },
      texture_image: "art/ember.png",
      pack_root: "models",
      model: "models/creature.bbmodel",
    });
    expect(effect.file).toBe(join(root, "models", "particles", "ember.json"));
    expect(effect.keyframe_file).toBe("particles/ember.json");
    expect(effect.texture_file).toBe(join(root, "models", "textures", "particle", "ember.png"));
    const json = await Bun.file(effect.file).json();
    expect(json.particle_effect.description.basic_render_parameters.texture).toBe("textures/particle/ember");

    await call("bbmodel_edit", {
      file: "models/creature.bbmodel",
      operations: [
        { op: "add_locator", name: "mouth", parent: "head", position: [0, 10, -11] },
        { op: "set_particle_keyframe", animation: "animation.creature.walk", time: 0, effect: effect.effect_name, file: effect.keyframe_file, locator: "mouth" },
      ],
    });

    const pack = await call<{ written: string[]; client_entity: unknown; problems: string[] }>("bbmodel_particle_pack", { file: "models/creature.bbmodel", destination: "RP" });
    expect(pack.written.toSorted()).toEqual([join(root, "RP", "particles", "ember.json"), join(root, "RP", "textures", "particle", "ember.png")].toSorted());
    expect(pack.client_entity).toEqual({ particle_effects: { ember: "test:ember" } });
    expect(pack.problems).toEqual([]);
    const again = await call<{ written: string[] }>("bbmodel_particle_pack", { file: "models/creature.bbmodel", destination: "RP" });
    expect(again.written).toEqual([]);
  });

  test("update rewrites only the knob's components; create refuses to overwrite", async () => {
    const call = await connect();
    await call("bbmodel_particle_effect", { identifier: "test:bubbles", preset: "bubbles" });
    const path = join(root, "particles", "bubbles.json");
    const before = await Bun.file(path).json();
    await call("bbmodel_particle_effect", { identifier: "test:bubbles", action: "update", design: { lifetime: 4 } });
    const after = await Bun.file(path).json();
    expect(after.particle_effect.components["minecraft:particle_lifetime_expression"]).toEqual({ max_lifetime: 4 });
    expect(after.particle_effect.components["minecraft:particle_motion_dynamic"]).toEqual(before.particle_effect.components["minecraft:particle_motion_dynamic"]);
    await expect(call("bbmodel_particle_effect", { identifier: "test:bubbles", preset: "bubbles" })).rejects.toThrow("already exists");
    await expect(call("bbmodel_particle_effect", { identifier: "test:none", action: "update", design: { rate: 2 } })).rejects.toThrow("does not exist");
  });

  test("update refuses another identifier's file; the pack accepts absolute keyframe paths and effects already in place", async () => {
    const call = await connect();
    await call("bbmodel_particle_effect", { identifier: "a:smoke", preset: "smoke", pack_root: "RP", design: { looping: false, duration: 1 } });
    await expect(call("bbmodel_particle_effect", { identifier: "b:smoke", action: "update", pack_root: "RP", design: { rate: 2 } })).rejects.toThrow("holds a:smoke");
    const absolute = join(root, "RP", "particles", "smoke.json");
    const doc = apply([{ op: "set_particle_keyframe", animation: "animation.creature.walk", time: 0, effect: "smoke", file: absolute }]).doc;
    await Bun.write(join(root, "models", "m.bbmodel"), JSON.stringify(doc));
    const pack = await call<{ written: string[]; already_in_pack: string[]; client_entity: unknown }>("bbmodel_particle_pack", { file: "models/m.bbmodel", destination: "RP" });
    expect(pack.written).toEqual([]);
    expect(pack.already_in_pack).toEqual([absolute]);
    expect(pack.client_entity).toEqual({ particle_effects: { smoke: "a:smoke" } });
  });

  test("the pack reports keyframes without files and missing locators", async () => {
    const call = await connect();
    const doc = apply([{ op: "set_particle_keyframe", animation: "animation.creature.walk", time: 0, effect: "handler_only" }]).doc;
    const track = doc.animations?.[0]?.animators[EFFECTS_ANIMATOR_KEY];
    const broken = track ? { ...doc, animations: [{ ...doc.animations![0]!, animators: { ...doc.animations![0]!.animators, [EFFECTS_ANIMATOR_KEY]: { ...track, keyframes: track.keyframes.map((key) => ({ ...key, data_points: [...key.data_points, { effect: "ghost", locator: "nowhere", file: "" }] })) } } }] } : doc;
    await Bun.write(join(root, "m.bbmodel"), JSON.stringify(broken));
    const pack = await call<{ problems: string[] }>("bbmodel_particle_pack", { file: "m.bbmodel", destination: "RP" });
    expect(pack.problems.join("\n")).toContain('effect "handler_only" has no particle file');
    expect(pack.problems.join("\n")).toContain('locator "nowhere" does not exist');
  });
});
