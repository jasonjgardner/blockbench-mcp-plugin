import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { required } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

/** Texture state that must survive undo/redo: identity by name, bitmap, and render settings. */
interface ITextureSnapshot {
  name: string;
  source: string;
  render_mode: string;
  render_sides: string;
  width: number;
  height: number;
  uv_width: number;
  uv_height: number;
}

/** Undo aspects `create_texture` passes to `Undo.initEdit` for an ungrouped texture. */
interface ITextureAspects {
  textures: TestTexture[];
  bitmap?: boolean;
}

let tools: IToolFixture;
let failDecode = false;
let decodeGate: Promise<void> | undefined;
let onDecode: (() => void) | undefined;

// The model stores only the textures supplied to Undo, matching Blockbench's
// before/post snapshots. Omitted new textures therefore cannot be removed.
function capture(value: ITextureAspects): ITextureSnapshot[] {
  return value.textures.map(({ name, source, render_mode, render_sides, width, height, uv_width, uv_height }) => ({
    name, source, render_mode, render_sides, width, height, uv_width, uv_height,
  }));
}

function restore(target: ITextureSnapshot[], reference: ITextureSnapshot[]): void {
  const affected = new Set(reference.map((texture) => texture.name));
  TestTexture.all = TestTexture.all.filter((texture) => !affected.has(texture.name));
  target.forEach((snapshot) => new TestTexture(snapshot).add());
}

class TestTexture {
  static all: TestTexture[] = [];
  uuid = crypto.randomUUID();
  id = this.uuid;
  name = "";
  group = "";
  pbr_channel = "color";
  source = "data:image/png;base64,Ymxhbms=";
  render_mode = "default";
  render_sides = "auto";
  width = 16;
  height = 16;
  uv_width = 16;
  uv_height = 16;
  layers_enabled = false;
  fill = "transparent";
  // Native Texture creates a 16x16 canvas independently of constructor options.
  // Its image load then takes bitmap dimensions from the serialized canvas.
  canvas = {
    width: 16,
    height: 16,
    toDataURL: (): string => `data:image/png;base64,${btoa(`canvas:${this.canvas.width},${this.canvas.height}:${this.fill}`)}`,
  };
  img = { decode: async (): Promise<void> => {
    onDecode?.();
    await decodeGate;
    if (failDecode) throw new Error("Image decode failed");
    const encoded = atob(this.source.split(",")[1]);
    if (!encoded.startsWith("canvas:")) return;
    const [width, height] = encoded.split(":")[1].split(",").map(Number);
    this.width = this.canvas.width = width;
    this.height = this.canvas.height = height;
  } };

  constructor(input: Partial<ITextureSnapshot> = {}) {
    Object.assign(this, input);
  }

  getActiveCanvas() {
    const ctx = {
      canvas: this.canvas,
      clearRect: () => { this.fill = "transparent"; },
      fillStyle: "",
      fillRect: () => {
        this.fill = ctx.fillStyle;
      },
    };
    return { ctx };
  }
  updateSource(source: string): void {
    this.source = source;
  }
  updateLayerChanges(): void {}
  updateMaterial(): void {}
  fromDataURL(source: string): this {
    this.source = source;
    return this;
  }
  load(): void {}
  fillParticle(): void {}
  getDataURL(): string {
    return this.source;
  }
  add(): this {
    TestTexture.all.push(this);
    return this;
  }
}

const undo = createUndoHost({ restore, snapshot: capture });

beforeAll(async () => {
  // A private bundle keeps this file's create_texture out of the shared factories
  // registry that server/tools/texture.test.ts registers into.
  tools = await loadToolDefinitions({ entries: ["server/tools/texture.ts"], register: ["registerTextureTools"] });
});
beforeEach(() => {
  TestTexture.all = [new TestTexture({ name: "existing" })];
  failDecode = false;
  decodeGate = undefined;
  onDecode = undefined;
  undo.reset();
});
useGlobals(() => ({
  Blockbench: { isWeb: false },
  Canvas: { updateAll() {} },
  Format: { id: "free", pbr: true, per_texture_uv_size: true },
  Project: { get textures() { return TestTexture.all; } },
  Texture: TestTexture,
  Undo: undo,
  tinycolor: (value: string) => ({ toRgbString: () => value }),
}));

describe("create_texture undo", () => {
  test.each([{ name: "blank" }, { name: "filled", fill_color: "#ff0000", layer_name: "Base" }])("$name bitmap resizes the native 16x16 backing canvas before serialization", async input => {
    await tools.call("create_texture", { ...input, width: 96, height: 32 });
    const texture = required(TestTexture.all.at(-1), "created texture");
    expect(texture).toMatchObject({ width: 96, height: 32, canvas: { width: 96, height: 32 } });
    expect(atob(texture.source.split(",")[1])).toBe(`canvas:96,32:${input.fill_color ?? "transparent"}`);
    undo.undo();
    undo.redo();
    expect(TestTexture.all.at(-1)).toMatchObject({ width: 96, height: 32, source: texture.source });
  });
  test("image decoding finishes before creation opens Undo or exposes the texture", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    decodeGate = gate.promise;
    onDecode = () => started.resolve();
    const creation = tools.call("create_texture", { name: "decoding", width: 64, height: 32 });
    await started.promise;
    expect(undo.starts).toBe(0);
    expect(TestTexture.all.map(texture => texture.name)).toEqual(["existing"]);
    gate.resolve();
    await creation;
    expect(TestTexture.all.at(-1)).toMatchObject({ name: "decoding", width: 64, height: 32 });
    expect(undo.finishes).toBe(1);
  });
  test("blank bitmap decode failure does not add a texture or start Undo", async () => {
    failDecode = true;
    await expect(tools.call("create_texture", { name: "broken", width: 64, height: 32 })).rejects.toThrow("Cannot decode the newly created texture bitmap.");
    expect(undo.starts).toBe(0);
    expect(TestTexture.all.map(texture => texture.name)).toEqual(["existing"]);
  });
  test("separate logical UV dimensions survive creation Undo/Redo", async () => {
    await tools.call("create_texture", { name: "atlas", width: 256, height: 128, uv_width: 64, uv_height: 32 });
    expect(TestTexture.all.at(-1)).toMatchObject({ width: 256, height: 128, uv_width: 64, uv_height: 32 });
    undo.undo();
    expect(TestTexture.all.map(texture => texture.name)).toEqual(["existing"]);
    undo.redo();
    expect(TestTexture.all.at(-1)).toMatchObject({ width: 256, height: 128, uv_width: 64, uv_height: 32 });
  });
  test("invalid UV sizes and project-wide formats reject before adding a texture", async () => {
    await expect(tools.call("create_texture", { name: "bad", uv_width: 32 })).rejects.toThrow("Supply both");
    await expect(tools.call("create_texture", { name: "bad", uv_width: 0, uv_height: 32 })).rejects.toThrow();
    Object.assign(globalThis, { Format: { id: "bedrock", per_texture_uv_size: false } });
    await expect(tools.call("create_texture", { name: "bad", uv_width: 64, uv_height: 32 })).rejects.toThrow("project-wide");
    expect(undo.starts).toBe(0);
    expect(TestTexture.all).toHaveLength(1);
  });
  test.each([
    { name: "blank" },
    { name: "filled", fill_color: "#ff0000", layer_name: "Base" },
    { name: "imported", data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j17sAAAAASUVORK5CYII=" },
  ])("undo removes $name and redo restores its bitmap and render settings", async (input) => {
    await tools.call("create_texture", { ...input, render_mode: "emissive", render_sides: "double" });
    const created = TestTexture.all.find((texture) => texture.name === input.name);
    expect(created).toBeDefined();
    const expected = capture({ textures: [required(created, `created texture "${input.name}"`)] });

    undo.undo();
    expect(TestTexture.all.map((texture) => texture.name)).toEqual(["existing"]);

    undo.redo();
    const restored = required(TestTexture.all.at(1), `restored texture "${input.name}"`);
    expect(capture({ textures: TestTexture.all.slice(1) })).toEqual(expected);
    expect(restored.render_mode).toBe("emissive");
    expect(restored.render_sides).toBe("double");
  });
});
