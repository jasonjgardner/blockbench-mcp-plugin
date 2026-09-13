import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MeshStandardMaterial } from "three";
import { setupMaterialUndoRefresh, teardownMaterialUndoRefresh, updateMaterialPreview } from "@/lib/material-preview";
import { useGlobals } from "@/tests/helpers/globals";
import type { IMaterialUniforms, PbrChannel } from "@/tests/helpers/shapes";

/** Largest byte in `material_config`; material uniforms are stored as byte / 255 fractions. */
const MAX_BYTE = 255;

type Handler = (event: unknown) => void;

class TestImage extends EventTarget {
  complete = false;
  naturalWidth = 0;
}

interface IGroupTexture {
  img: TestImage;
  pbr_channel: PbrChannel;
}

class TestGroup {
  is_material = true;
  material = new MeshStandardMaterial();
  material_config: IMaterialUniforms = { color_value: [10, 20, 30, 128], mer_value: [0, 0, 40] };
  textures: IGroupTexture[] = [];
  updates = 0;
  broken = false;
  constructor(readonly uuid: string, readonly name = uuid) {}
  getTextures(): IGroupTexture[] {
    return this.textures;
  }
  updateMaterial(): void {
    this.updates++;
    if (this.broken) throw new Error("Legacy material failed");
    // Native undo leaves this cache untouched; the host's RGB-object/alpha
    // issue also leaves uniform color white and opacity non-finite.
    this.material.color.set(0xffffff);
    this.material.opacity = Number.NaN;
    const hasLoadedMer = this.textures.some(texture => texture.pbr_channel === "mer" && texture.img.naturalWidth > 0);
    this.material.roughness = hasLoadedMer ? 1 : this.material_config.mer_value[2] / MAX_BYTE;
  }
}

const handlers = new Map<string, Set<Handler>>();
let groups: TestGroup[] = [];
let canvasRefreshes = 0;

beforeEach(() => {
  handlers.clear();
  groups = [];
  canvasRefreshes = 0;
});
// teardown still calls Blockbench.removeListener, so it must run before useGlobals restores the host.
afterEach(() => teardownMaterialUndoRefresh());
useGlobals(() => ({
  Blockbench: {
    on(name: string, handler: Handler): void {
      handlers.set(name, new Set([...(handlers.get(name) ?? []), handler]));
    },
    removeListener(name: string, handler: Handler): void {
      handlers.get(name)?.delete(handler);
    },
  },
  Canvas: {
    updateAllFaces(): void {
      canvasRefreshes++;
    },
  },
  Project: {},
  TextureGroup: {
    get all(): TestGroup[] {
      return groups;
    },
  },
}));

function loaded(save: unknown, reference: unknown = {}): void {
  handlers.get("load_undo_save")?.forEach(handler => handler({ save, reference }));
}

describe("material preview restoration", () => {
  test("corrects uniform RGB and RGBA opacity after native material refresh", () => {
    const group = new TestGroup("uniform");
    updateMaterialPreview(group as unknown as TextureGroup);
    expect(group.material.color.toArray()).toEqual([10 / MAX_BYTE, 20 / MAX_BYTE, 30 / MAX_BYTE]);
    expect(group.material.opacity).toBe(128 / MAX_BYTE);
    expect(group.material.roughness).toBe(40 / MAX_BYTE);
  });

  test("native undo and redo refresh only restored or removed-reference groups", () => {
    const restored = new TestGroup("restored");
    const source = new TestGroup("source");
    const unrelated = new TestGroup("unrelated");
    groups = [restored, source, unrelated];
    restored.material.roughness = 80 / MAX_BYTE;
    setupMaterialUndoRefresh();
    loaded({ texture_groups: { restored: {} } }, { texture_groups: { restored: {}, source: {} } });
    expect(restored.material.roughness).toBe(40 / MAX_BYTE);
    expect(source.updates).toBe(1);
    expect(unrelated.updates).toBe(0);
    restored.material_config.mer_value = [0, 0, 80];
    loaded({ texture_groups: { restored: {} } });
    expect(restored.material.roughness).toBe(80 / MAX_BYTE);
    expect(canvasRefreshes).toBe(2);
  });

  test("redo refreshes imported channel images once decoding finishes", () => {
    const group = new TestGroup("images");
    const image = new TestImage();
    group.textures = [{ img: image, pbr_channel: "mer" }];
    groups = [group];
    setupMaterialUndoRefresh();
    loaded({ texture_groups: { images: {} } });
    expect(group.material.roughness).toBe(40 / MAX_BYTE);
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
