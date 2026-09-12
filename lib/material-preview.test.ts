import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MeshStandardMaterial } from "three";
import { setupMaterialUndoRefresh, teardownMaterialUndoRefresh, updateMaterialPreview } from "./material-preview";

type Handler = (event: unknown) => void;
class TestImage extends EventTarget {
  complete = false;
  naturalWidth = 0;
}

class TestGroup {
  is_material = true;
  material = new MeshStandardMaterial();
  material_config = { color_value: [10, 20, 30, 128], mer_value: [0, 0, 40] };
  textures: Array<{ img: TestImage; pbr_channel: string }> = [];
  updates = 0;
  broken = false;
  constructor(readonly uuid: string, readonly name = uuid) {}
  getTextures() { return this.textures; }
  updateMaterial(): void {
    this.updates++;
    if (this.broken) throw new Error("Legacy material failed");
    // Native undo leaves this cache untouched; the host's RGB-object/alpha
    // issue also leaves uniform color white and opacity non-finite.
    this.material.color.set(0xffffff);
    this.material.opacity = Number.NaN;
    this.material.roughness = this.textures.some(texture => texture.pbr_channel === "mer" && texture.img.naturalWidth > 0) ? 1 : this.material_config.mer_value[2] / 255;
  }
}

const names = ["Blockbench", "TextureGroup", "Project", "Canvas"];
const original = new Map<string, PropertyDescriptor | undefined>();
const handlers = new Map<string, Set<Handler>>();
let groups: TestGroup[] = [];
let canvasRefreshes = 0;

beforeAll(() => names.forEach(name => original.set(name, Object.getOwnPropertyDescriptor(globalThis, name))));
beforeEach(() => {
  handlers.clear();
  groups = [];
  canvasRefreshes = 0;
  Object.assign(globalThis, {
    Project: {},
    TextureGroup: { get all() { return groups; } },
    Canvas: { updateAllFaces() { canvasRefreshes++; } },
    Blockbench: {
      on(name: string, handler: Handler) {
        const entries = handlers.get(name) ?? new Set<Handler>();
        entries.add(handler);
        handlers.set(name, entries);
      },
      removeListener(name: string, handler: Handler) { handlers.get(name)?.delete(handler); },
    },
  });
});
afterEach(() => teardownMaterialUndoRefresh());
afterAll(() => original.forEach((descriptor, name) => {
  if (descriptor) { Object.defineProperty(globalThis, name, descriptor); return; }
  Reflect.deleteProperty(globalThis, name);
}));

function loaded(save: unknown, reference: unknown = {}): void {
  handlers.get("load_undo_save")?.forEach(handler => handler({ save, reference }));
}

describe("material preview restoration", () => {
  test("corrects uniform RGB and RGBA opacity after native material refresh", () => {
    const group = new TestGroup("uniform");
    updateMaterialPreview(group as unknown as TextureGroup);
    expect(group.material.color.toArray()).toEqual([10 / 255, 20 / 255, 30 / 255]);
    expect(group.material.opacity).toBe(128 / 255);
    expect(group.material.roughness).toBe(40 / 255);
  });

  test("native undo and redo refresh only restored or removed-reference groups", () => {
    const restored = new TestGroup("restored");
    const source = new TestGroup("source");
    const unrelated = new TestGroup("unrelated");
    groups = [restored, source, unrelated];
    restored.material.roughness = 80 / 255;
    setupMaterialUndoRefresh();
    loaded({ texture_groups: { restored: {} } }, { texture_groups: { restored: {}, source: {} } });
    expect(restored.material.roughness).toBe(40 / 255);
    expect(source.updates).toBe(1);
    expect(unrelated.updates).toBe(0);
    restored.material_config.mer_value = [0, 0, 80];
    loaded({ texture_groups: { restored: {} } });
    expect(restored.material.roughness).toBe(80 / 255);
    expect(canvasRefreshes).toBe(2);
  });

  test("redo refreshes imported channel images once decoding finishes", () => {
    const group = new TestGroup("images");
    const image = new TestImage();
    group.textures = [{ img: image, pbr_channel: "mer" }];
    groups = [group];
    setupMaterialUndoRefresh();
    loaded({ texture_groups: { images: {} } });
    expect(group.material.roughness).toBe(40 / 255);
    image.naturalWidth = 16;
    image.complete = true;
    image.dispatchEvent(new Event("load"));
    expect(group.material.roughness).toBe(1);
    expect(group.updates).toBe(2);
    image.dispatchEvent(new Event("load"));
    expect(group.updates).toBe(2);
  });

  test("setup is idempotent and teardown removes undo and pending image listeners", () => {
    const group = new TestGroup("pending");
    const image = new TestImage();
    group.textures = [{ img: image, pbr_channel: "color" }];
    groups = [group];
    setupMaterialUndoRefresh();
    setupMaterialUndoRefresh();
    expect(handlers.get("load_undo_save")?.size).toBe(1);
    loaded({ texture_groups: { pending: {} } });
    teardownMaterialUndoRefresh();
    expect(handlers.get("load_undo_save")?.size).toBe(0);
    image.naturalWidth = 16;
    image.dispatchEvent(new Event("load"));
    expect(group.updates).toBe(1);
  });

  test("ignores unrelated snapshots and image callbacks after a project switch", () => {
    const group = new TestGroup("old-project");
    const image = new TestImage();
    group.textures = [{ img: image, pbr_channel: "normal" }];
    groups = [group];
    setupMaterialUndoRefresh();
    loaded({ textures: { texture: {} } });
    expect(group.updates).toBe(0);
    loaded({ texture_groups: { "old-project": {} } });
    Object.assign(globalThis, { Project: {} });
    image.dispatchEvent(new Event("load"));
    expect(group.updates).toBe(1);
  });

  test("a malformed legacy material cannot interrupt native undo", () => {
    const group = new TestGroup("legacy");
    group.broken = true;
    groups = [group];
    setupMaterialUndoRefresh();
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => loaded({ texture_groups: { legacy: {} } })).not.toThrow();
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
});
