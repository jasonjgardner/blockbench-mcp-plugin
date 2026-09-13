import { beforeAll, describe, expect, test } from "bun:test";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
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
