import { beforeAll, describe, expect, test } from "bun:test";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { isRecord } from "@/tests/helpers/assertions";
import { installGlobals, useGlobals } from "@/tests/helpers/globals";

let resources: IToolFixture;
const plugins = { installed: [{ id: "reference_models" }, { id: "hytale_plugin", disabled: false }] };

beforeAll(async () => {
  const restore = installGlobals({ Plugins: plugins });
  try {
    resources = await loadToolDefinitions({
      entries: ["server/resources.ts", "server/resources/hytale.ts", "server/resources/validator.ts"],
      register: ["registerHytaleResources", "registerValidatorResources"],
      shims: {
        "lib/factories.ts": `
          export const definitions = new Map();
          export function createResource(name, config) {
            definitions.set(name, {
              parameters: { parse: (value) => value, parseAsync: async (value) => value },
              execute: ({ uri, id }) => uri ? config.readCallback(new URL(uri), { id }) : config.listCallback(),
            });
          }
        `,
      },
    });
  } finally {
    restore();
  }
});

useGlobals(() => ({
  ModelProject: { all: [] },
  Project: undefined,
  Outliner: { elements: [] },
  OutlinerNode: { uuids: {} },
  Plugins: plugins,
  Format: { id: "free" },
  Cube: { all: [] },
  Group: { all: [] },
  Collection: { all: [] },
  Validator: { checks: [], errors: [], warnings: [], triggers: [] },
}));

describe("resource missing item behavior", () => {
  test.each([
    ["projects", "projects://missing"],
    ["textures", "textures://missing"],
    ["nodes", "nodes://missing"],
    ["reference_models", "reference-models://missing"],
    ["validator-checks", "validator://checks/missing"],
  ])("%s rejects named misses even when its collection is empty", async (name, uri) => {
    await expect(resources.call(name, { uri, id: "missing" })).rejects.toMatchObject({ code: -32602, data: { uri } });
  });

  test.each([
    ["hytale-format", "hytale://format"],
    ["hytale-attachments", "hytale://attachments/missing"],
    ["hytale-pieces", "hytale://pieces/missing"],
    ["hytale-cubes", "hytale://cubes/missing"],
  ])("%s rejects reads when the format is unavailable", async (name, uri) => {
    await expect(resources.call(name, { uri, id: "missing" })).rejects.toMatchObject({ code: -32602, data: { uri } });
  });

  test.each([
    ["hytale-attachments", "hytale://attachments/missing"],
    ["hytale-pieces", "hytale://pieces/missing"],
    ["hytale-cubes", "hytale://cubes/missing"],
  ])("%s rejects missing items in an active Hytale format", async (name, uri) => {
    Reflect.set(globalThis, "Format", { id: "hytale_character" });
    await expect(resources.call(name, { uri, id: "missing" })).rejects.toMatchObject({ code: -32602, data: { uri } });
  });

  test.each(["project-files", "projects", "textures", "nodes", "reference_models"])("%s permits an empty resource list", async (name) => {
    expect(await resources.call(name, {})).toEqual({ resources: [] });
  });

  test("lists reference models with a valid URI scheme and resolves the listed slug", async () => {
    Reflect.set(globalThis, "Outliner", { elements: [{ uuid: "reference-id", name: "Turntable", type: "reference_model" }] });
    expect(await resources.call("reference_models", {})).toEqual({
      resources: [{ uri: "reference-models://turntable", name: "Turntable", description: "Reference model", mimeType: "application/json" }],
    });
    expect(await resources.call("reference_models", { uri: "reference-models://turntable", id: "turntable" })).toMatchObject({
      contents: [{ uri: "reference-models://turntable", mimeType: "application/json" }],
    });
  });

  test("collection reads preserve a real empty resource instead of treating it as a named miss", async () => {
    expect(await resources.call("projects", { uri: "projects://" })).toEqual({
      contents: [{ uri: "projects://", mimeType: "application/json", text: '{"projects":[],"count":0}' }],
    });
  });
});

describe("nodes resource", () => {
  /** Marks each key as a registered `Property`, like `new Property(Type, ..., key)` does in Blockbench. */
  const registered = (keys: string[]): Record<string, object> => Object.fromEntries(keys.map((key) => [key, {}]));

  /** A cube as Blockbench 5.2 defines it: from/to/origin/rotation are plain fields, not registered properties. */
  class TestCube {
    static properties = registered(["name", "box_uv", "render_order", "rescale", "locked", "shade", "shade_direction_override", "light_emission"]);
    readonly uuid = "cube-1";
    readonly type = "cube";
    readonly name = "body";
    readonly parent = { uuid: "group-1" };
    readonly box_uv = false;
    readonly render_order = "default";
    readonly rescale = false;
    readonly locked = false;
    readonly shade = true;
    readonly shade_direction_override = "";
    readonly light_emission = 0;
    readonly from = [0, 0, 0];
    readonly to = [4, 6, 4];
    readonly origin = [2, 0, 2];
    readonly rotation = [0, 45, 0];
    readonly autouv = 0;
    readonly color = 3;
    /** Like `Cube#getSaveCopy` in 5.2: registered properties, then the geometry fields, faces, type and uuid. */
    getSaveCopy(): Record<string, unknown> {
      const saved: Record<string, unknown> = {};
      Object.keys(TestCube.properties).forEach((key) => { saved[key] = Reflect.get(this, key); });
      return {
        ...saved,
        from: this.from,
        to: this.to,
        autouv: this.autouv,
        color: this.color,
        ...(this.rotation.every((value) => value === 0) ? {} : { rotation: this.rotation }),
        origin: this.origin,
        faces: { north: { uv: [0, 0, 4, 6], texture: "texture-1" } },
        type: this.type,
        uuid: this.uuid,
      };
    }
  }

  /** What `Group#getSaveCopy(false)` returns in 5.2: a childless Group instance, internals included. */
  class TestGroupCopy {
    readonly _static = Object.freeze({ properties: {}, temp_data: {} });
    readonly children: unknown[] = [];
    readonly isOpen = true;
    constructor(readonly uuid: string, readonly name: string, readonly origin: number[], readonly rotation: number[]) {}
  }

  class TestGroup {
    static properties = registered(["origin", "rotation", "scope", "bedrock_binding", "cem_animations", "cem_attach", "cem_model", "cem_scale", "texture", "skin_original_origin", "color"]);
    readonly uuid = "group-1";
    readonly type = "group";
    readonly name = "torso";
    readonly parent = "root";
    readonly origin = [0, 12, 0];
    readonly rotation = [10, 0, 0];
    readonly children = [{ uuid: "cube-1" }];
    getSaveCopy(): TestGroupCopy {
      return new TestGroupCopy(this.uuid, this.name, this.origin, this.rotation);
    }
  }

  /** A plugin node without `getSaveCopy`: only its registered properties describe it. */
  class TestPluginNode {
    static properties = registered(["name", "size"]);
    readonly uuid = "plugin-1";
    readonly type = "plugin_box";
    readonly name = "crate";
    readonly parent = "root";
    readonly size = [1, 2, 3];
  }

  /** A three.js node; serializing it calls its parent's Object3D.toJSON, which dumped the whole scene. */
  function sceneNode(uuid: string, type: string): Record<string, unknown> {
    const vector = { toArray: () => [0, 0, 0] };
    const scene = { toJSON: () => ({ geometries: ["whole scene"], textures: ["pixels"] }) };
    return { uuid: `three-${uuid}`, name: uuid, type, parent: scene, geometry: { attributes: {} }, position: vector, rotation: vector, scale: vector };
  }

  async function readNode(id: string): Promise<unknown> {
    const result = await resources.call("nodes", { uri: `nodes://${id}`, id });
    const content = isRecord(result) && Array.isArray(result.contents) ? result.contents[0] : undefined;
    if (!isRecord(content) || typeof content.text !== "string") throw new Error("Expected one text content.");
    expect(content.text).not.toContain("whole scene");
    return JSON.parse(content.text);
  }

  test("does not resolve inherited object keys as node ids", async () => {
    Reflect.set(globalThis, "Project", { nodes_3d: { "cube-1": sceneNode("cube-1", "cube") } });
    Reflect.set(globalThis, "OutlinerNode", { uuids: {} });
    for (const id of ["constructor", "__proto__", "toString"]) {
      await expect(resources.call("nodes", { uri: `nodes://${id}`, id })).rejects.toMatchObject({ code: -32602 });
    }
  });

  test("returns each node as Blockbench saves it, plus its place in the outliner", async () => {
    Reflect.set(globalThis, "Project", {
      nodes_3d: { "cube-1": sceneNode("cube-1", "cube"), "group-1": sceneNode("group-1", "group"), "plugin-1": sceneNode("plugin-1", "plugin_box") },
    });
    Reflect.set(globalThis, "OutlinerNode", {
      uuids: { "cube-1": new TestCube(), "group-1": new TestGroup(), "plugin-1": new TestPluginNode() },
    });

    expect(await readNode("cube-1")).toEqual({
      uuid: "cube-1",
      name: "body",
      type: "cube",
      parent: "group-1",
      box_uv: false,
      render_order: "default",
      rescale: false,
      locked: false,
      shade: true,
      shade_direction_override: "",
      light_emission: 0,
      from: [0, 0, 0],
      to: [4, 6, 4],
      autouv: 0,
      color: 3,
      rotation: [0, 45, 0],
      origin: [2, 0, 2],
      faces: { north: { uv: [0, 0, 4, 6], texture: "texture-1" } },
    });
    expect(await readNode("group-1")).toEqual({
      uuid: "group-1",
      name: "torso",
      type: "group",
      parent: "root",
      children: ["cube-1"],
      origin: [0, 12, 0],
      rotation: [10, 0, 0],
      isOpen: true,
    });
    expect(await readNode("plugin-1")).toEqual({ uuid: "plugin-1", name: "crate", type: "plugin_box", parent: "root", size: [1, 2, 3] });
  });
});
