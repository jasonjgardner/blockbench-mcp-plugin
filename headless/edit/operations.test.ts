import { describe, expect, test } from "bun:test";
import { creatureModel } from "../test-fixtures";
import { isCube } from "../document/schema";
import { emptyModel } from "../tools/edit";
import { matchesName } from "../tools/inspect";
import { applyOperations, operationSchema, stampAiUsage } from "./operations";

const ops = (list: unknown[]) => operationSchema.array().parse(list);

describe("caller-supplied UUIDs", () => {
  test("a UUID already in the model is refused", () => {
    const uuid = crypto.randomUUID();
    expect(() => applyOperations(creatureModel(), ops([
      { op: "add_group", name: "a", uuid },
      { op: "add_group", name: "b", uuid },
    ]))).toThrow("already used");
  });
});

describe("PBR materials (Blockbench texture groups)", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const texture = (name: string, extra: Record<string, unknown> = {}) => ({ op: "add_texture", name, source: png, width: 256, height: 256, ...extra });

  test("textures fill material channels the way Blockbench saves them", () => {
    const doc = applyOperations(creatureModel(), ops([
      { op: "add_material", name: "steel", mer_value: [255, 0, 60] },
      texture("steel_color", { material: "steel", wrap_mode: "repeat" }),
      texture("steel_normal", { material: "steel", channel: "normal" }),
      texture("steel_mer", { material: "steel", channel: "mer" }),
    ])).doc;
    const [material] = doc.texture_groups ?? [];
    expect(material).toMatchObject({ name: "steel", is_material: true, material_config: { mer_value: [255, 0, 60] } });
    expect(doc.textures.map((t) => [t.name, t.group === material?.uuid, t.pbr_channel, t.wrap_mode ?? null])).toEqual([
      ["steel_color", true, "color", "repeat"],
      ["steel_normal", true, "normal", null],
      ["steel_mer", true, "mer", null],
    ]);
  });

  test("a filled channel, or normal plus height, is refused", () => {
    const base = ops([{ op: "add_material", name: "m" }, texture("a", { material: "m", channel: "normal" })]);
    expect(() => applyOperations(creatureModel(), [...base, ...ops([texture("b", { material: "m", channel: "normal" })])])).toThrow("already has a normal");
    expect(() => applyOperations(creatureModel(), [...base, ...ops([texture("c", { material: "m", channel: "height" })])])).toThrow("normal or height");
  });

  test("update_texture moves a texture between materials and out of them", () => {
    const doc = applyOperations(creatureModel(), ops([
      { op: "add_material", name: "a" },
      { op: "add_material", name: "b" },
      texture("t", { material: "a" }),
      { op: "update_texture", target: "t", material: "b", channel: "mer" },
    ])).doc;
    const b = doc.texture_groups?.find((g) => g.name === "b");
    expect(doc.textures[0]).toMatchObject({ group: b?.uuid, pbr_channel: "mer" });
    const detached = applyOperations(doc, ops([{ op: "update_texture", target: "t", material: null }])).doc;
    expect(detached.textures[0]?.group).toBeUndefined();
  });
});

describe("texture images", () => {
  const onePixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  test("update_texture with a new source embeds it and drops the file link and layers Blockbench would show instead", () => {
    const layers = [{ name: "paint", uuid: crypto.randomUUID(), type: "pixel_layer", data_url: onePixel }];
    const linked = { ...creatureModel(), textures: [{ uuid: crypto.randomUUID(), name: "skin", path: "C:/models/skin.png", relative_path: "../skin.png", source: onePixel, width: 1, height: 1, internal: false, saved: true, layers_enabled: true, layers }] };
    const renamed = applyOperations(linked, ops([{ op: "update_texture", target: "skin", name: "hide" }])).doc;
    expect(renamed.textures[0]).toMatchObject({ name: "hide", path: "C:/models/skin.png", relative_path: "../skin.png", internal: false, saved: true, layers_enabled: true, layers });
    const replacement = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAYAAACk7+45AAAAFklEQVR4nGP838Dwn4GBgYEJRGBnAABUcQKGuqbVnwAAAABJRU5ErkJggg==";
    const replaced = applyOperations(renamed, ops([{ op: "update_texture", target: "hide", source: replacement, width: 2, height: 4 }])).doc;
    expect(replaced.textures[0]).toMatchObject({ name: "hide", source: replacement, width: 2, height: 4, path: "", relative_path: "", internal: true, saved: false, layers_enabled: false });
    expect(replaced.textures[0]).not.toHaveProperty("layers");
  });
});

describe("AI usage stamp", () => {
  test("a client is listed once however often it writes, even when its name contains the list separator", () => {
    const once = stampAiUsage(creatureModel(), "Claude, Code");
    expect(once).toMatchObject({ ai_used: true, ai_agents: "Claude Code" });
    expect(stampAiUsage(stampAiUsage(once, "Claude, Code"), "Claude, Code").ai_agents).toBe("Claude Code");
    expect(stampAiUsage(once, "other").ai_agents).toBe("Claude Code, other");
  });

  test("a client name with nothing printable is recorded as the unknown client, like the plugin does", () => {
    expect(stampAiUsage(creatureModel(), " ,\u0000, ").ai_agents).toBe("Unknown MCP client");
    expect(stampAiUsage({ ...creatureModel(), ai_agents: "Claude Code" }, "").ai_agents).toBe("Claude Code, Unknown MCP client");
  });
});

describe("box UV sizes follow the format", () => {
  test("modded_entity keeps fractional sizes (box_uv_float_size), others floor them", () => {
    const cube = { op: "add_cube", name: "fin", from: [0, 0, 0], to: [2.5, 1, 1], box_uv: true };
    const northOf = (format: string): unknown => {
      const doc = applyOperations(emptyModel(format, "", true, { width: 64, height: 64 }), ops([cube])).doc;
      const [element] = doc.elements;
      return element && isCube(element) ? element.faces.north?.uv : undefined;
    };
    expect(northOf("modded_entity")).toEqual([1, 1, 3.5, 2]);
    expect(northOf("bedrock")).toEqual([1, 1, 3, 2]);
  });
});

describe("element name search", () => {
  test.each([
    ["leg_front_l", "leg_*", true],
    ["leg_front_l", "*_l", true],
    ["leg_front_l", "LEG*FRONT*L", true],
    ["leg_front_l", "front", true],
    ["leg_front_l", "arm*", false],
    ["a", "a*a", false],
  ])("%s matches %s: %p", (name, pattern, expected) => {
    expect(matchesName(name, pattern)).toBe(expected);
  });

  test("patterns that would backtrack catastrophically as regexes finish immediately", () => {
    const started = performance.now();
    expect(matchesName(`${"a".repeat(5000)}!`, "(a+)+$")).toBe(false);
    expect(matchesName("a".repeat(5000), `${"*a".repeat(100)}*`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("animations", () => {
  test("remove_animation deletes a clip by name", () => {
    const doc = applyOperations(creatureModel(true), ops([{ op: "remove_animation", animation: "animation.creature.walk" }])).doc;
    expect(doc.animations).toEqual([]);
    expect(() => applyOperations(doc, ops([{ op: "remove_animation", animation: "nope" }]))).toThrow("No animation");
  });
});
