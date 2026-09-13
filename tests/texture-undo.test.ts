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
}

/** Undo aspects `create_texture` passes to `Undo.initEdit` for an ungrouped texture. */
interface ITextureAspects {
  textures: TestTexture[];
  bitmap?: boolean;
}

let tools: IToolFixture;

// The model stores only the textures supplied to Undo, matching Blockbench's
// before/post snapshots. Omitted new textures therefore cannot be removed.
function capture(value: ITextureAspects): ITextureSnapshot[] {
  return value.textures.map(({ name, source, render_mode, render_sides }) => ({
    name, source, render_mode, render_sides,
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
  layers_enabled = false;
  img = { decode: async () => {} };

  constructor(input: Partial<ITextureSnapshot> = {}) {
    Object.assign(this, input);
  }

  getActiveCanvas() {
    const ctx = {
      canvas: { toDataURL: () => this.source },
      clearRect: () => {},
      fillStyle: "",
      fillRect: () => {
        this.source = `data:image/png;base64,${btoa(ctx.fillStyle)}`;
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
  undo.reset();
});
useGlobals(() => ({
  Blockbench: { isWeb: false },
  Canvas: { updateAll() {} },
  Format: { id: "free", pbr: true },
  Project: { get textures() { return TestTexture.all; } },
  Texture: TestTexture,
  Undo: undo,
  tinycolor: (value: string) => ({ toRgbString: () => value }),
}));

describe("create_texture undo", () => {
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
