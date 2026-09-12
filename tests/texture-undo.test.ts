import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { z } from "zod";

type TextureSnapshot = {
  name: string;
  source: string;
  render_mode: string;
  render_sides: string;
};

type TextureAspects = { textures: TestTexture[] };
type TextureTool = {
  parameters: z.ZodType<unknown>;
  execute: (input: unknown) => Promise<unknown>;
};

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let createTexture: TextureTool;
let before: TextureSnapshot[];
let after: TextureSnapshot[];
let aspects: TextureAspects;

// The model stores only the textures supplied to Undo, matching Blockbench's
// before/post snapshots. Omitted new textures therefore cannot be removed.
function capture(value: TextureAspects): TextureSnapshot[] {
  return value.textures.map(({ name, source, render_mode, render_sides }) => ({
    name, source, render_mode, render_sides,
  }));
}

function restore(target: TextureSnapshot[], reference: TextureSnapshot[]): void {
  const affected = new Set(reference.map((texture) => texture.name));
  TestTexture.all = TestTexture.all.filter((texture) => !affected.has(texture.name));
  target.forEach((snapshot) => new TestTexture(snapshot).add());
}

class TestTexture {
  static all: TestTexture[] = [];
  name = "";
  source = "data:image/png;base64,Ymxhbms=";
  render_mode = "default";
  render_sides = "auto";
  width = 16;
  height = 16;
  layers_enabled = false;

  constructor(input: Partial<TextureSnapshot> = {}) {
    Object.assign(this, input);
  }

  getActiveCanvas() {
    const ctx = {
      canvas: { toDataURL: () => this.source },
      clearRect: () => {},
      fillStyle: "",
      fillRect: () => { this.source = `data:image/png;base64,${btoa(ctx.fillStyle)}`; },
    };
    return { ctx };
  }
  updateSource(source: string) { this.source = source; }
  updateLayerChanges() {}
  updateMaterial() {}
  load() {}
  fillParticle() {}
  getDataURL() { return this.source; }
  add() { TestTexture.all.push(this); return this; }
}

beforeAll(async () => {
  // Bundle a private registration shim so this test does not replace factory
  // imports or module caches used by other Bun test files.
  const result = await Bun.build({
    entrypoints: [`${import.meta.dir}/../server/tools/texture.ts`],
    target: "bun",
    format: "cjs",
    plugins: [{
      name: "capture-texture-tools",
      setup(build) {
        build.onLoad({ filter: /[/\\]lib[/\\]factories\.ts$/ }, () => ({
          contents: "export const definitions = new Map(); export function createTool(name, tool) { definitions.set(name, tool); }",
          loader: "js",
        }));
        build.onLoad({ filter: /[/\\]server[/\\]tools[/\\]texture\.ts$/ }, async ({ path }) => ({
          contents: `${await Bun.file(path).text()}\nexport { definitions } from '@/lib/factories';`,
          loader: "ts",
        }));
      },
    }],
  });
  if (!result.success) throw new AggregateError(result.logs, "Texture test bundle failed");
  const fixturePath = `${import.meta.dir}/.texture-undo-${crypto.randomUUID()}.cjs`;
  await Bun.write(fixturePath, result.outputs[0]);
  const fixture = await import(fixturePath).finally(() => Bun.file(fixturePath).delete()) as {
    registerTextureTools: () => void;
    definitions: Map<string, TextureTool>;
  };
  fixture.registerTextureTools();
  const definition = fixture.definitions.get("create_texture");
  if (!definition) throw new Error("create_texture was not registered");
  createTexture = definition;
});

beforeEach(() => {
  TestTexture.all = [new TestTexture({ name: "existing" })];
  before = [];
  after = [];
  const globals = {
    Texture: TestTexture,
    Canvas: { updateAll() {} },
    tinycolor: (value: string) => ({ toRgbString: () => value }),
    Undo: {
      initEdit(value: TextureAspects) {
        aspects = value;
        before = capture(value);
      },
      finishEdit(_message: string, value = aspects) { after = capture(value); },
    },
  };
  Object.entries(globals).forEach(([key, value]) => {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  });
});

afterEach(() => {
  originalGlobals.forEach((descriptor, key) => {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
      return;
    }
    Reflect.deleteProperty(globalThis, key);
  });
  originalGlobals.clear();
});

describe("create_texture undo", () => {
  test.each([
    { name: "blank" },
    { name: "filled", fill_color: "#ff0000", layer_name: "Base" },
    { name: "imported", data: "data:image/png;base64,aW1wb3J0ZWQ=" },
  ])("undo removes $name and redo restores its bitmap and render settings", async (input) => {
    const parameters = createTexture.parameters.parse({
      ...input, render_mode: "emissive", render_sides: "double",
    });
    await createTexture.execute(parameters);
    const created = TestTexture.all.find((texture) => texture.name === input.name);
    expect(created).toBeDefined();
    const expected = capture({ textures: created ? [created] : [] });

    restore(before, after);
    expect(TestTexture.all.map((texture) => texture.name)).toEqual(["existing"]);

    restore(after, before);
    expect(capture({ textures: TestTexture.all.slice(1) })).toEqual(expected);
    expect(TestTexture.all[1].render_mode).toBe("emissive");
    expect(TestTexture.all[1].render_sides).toBe("double");
  });
});
