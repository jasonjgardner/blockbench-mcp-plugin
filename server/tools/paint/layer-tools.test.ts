import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { createUndoHost } from "@/tests/helpers/undo-host";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";

/**
 * Headless doubles of Blockbench 5.2's texture layer classes (`js/texturing/layers.ts`),
 * reduced to what `texture_layer_management` and the paint target guard use.
 */
interface ILayerState {
  uuid: string;
  name: string;
  type: string;
  parent_uuid: string;
  visible: boolean;
  opacity?: number;
  blend_mode?: string;
  pixels?: string[];
  folded?: boolean;
}

let nextId = 0;

class FakeItem {
  texture: FakeTexture;
  name: string;
  uuid = `id${++nextId}`;
  parent_uuid = "";
  visible = true;
  multi_selected = false;
  type = "layer";

  constructor(data: { name?: string }, texture: FakeTexture) {
    this.texture = texture;
    this.name = data.name ?? "layer";
  }
  get parent(): FakeGroup | null {
    const parent = this.texture.layers.find(item => item.uuid === this.parent_uuid);
    return parent instanceof FakeGroup ? parent : null;
  }
  select(): void {
    this.texture.selected_layer = this;
    this.texture.layers.splice(0, this.texture.layers.length, ...FakeItem.solveLayerOrder(this.texture.layers));
  }
  addForEditing(): this {
    const index = this.texture.selected_layer ? this.texture.layers.indexOf(this.texture.selected_layer) : -1;
    this.texture.layers.splice(index === -1 ? this.texture.layers.length : index + 1, 0, this);
    this.select();
    return this;
  }
  remove(): void {
    const index = this.texture.layers.indexOf(this);
    this.texture.layers.splice(index, 1);
    if (this.texture.selected_layer === this) this.texture.selected_layer = this.texture.layers[index - 1] ?? this.texture.layers[index] ?? null;
  }
  /** Port of `TextureLayerItem.solveLayerOrder`. */
  static solveLayerOrder(list: FakeItem[]): FakeItem[] {
    const byParent = list.toReversed().reduce<Map<string, FakeItem[]>>(
      (map, item) => map.set(item.parent_uuid, [...(map.get(item.parent_uuid) ?? []), item]),
      new Map([["", []]])
    );
    const sorted: FakeItem[] = [];
    const add = (item: FakeItem): void => {
      sorted.unshift(item);
      (byParent.get(item.uuid) ?? []).forEach(add);
    };
    (byParent.get("") ?? []).forEach(add);
    return sorted;
  }
}

class FakeLayer extends FakeItem {
  type = "pixel_layer";
  opacity = 100;
  blend_mode = "default";
  offset = [0, 0];
  width = 16;
  height = 16;
  pixels: string[];

  constructor(data: { name?: string; opacity?: number; blend_mode?: string; parent_uuid?: string; visible?: boolean; pixels?: string[] }, texture: FakeTexture) {
    super(data, texture);
    this.opacity = data.opacity ?? 100;
    this.blend_mode = data.blend_mode ?? "default";
    this.parent_uuid = data.parent_uuid ?? "";
    this.visible = data.visible ?? true;
    this.pixels = [...(data.pixels ?? [])];
  }
  getUndoCopy(): Record<string, unknown> {
    return { uuid: this.uuid, name: this.name, opacity: this.opacity, blend_mode: this.blend_mode, parent_uuid: this.parent_uuid, visible: this.visible, pixels: [...this.pixels] };
  }
  setSize(): this {
    return this;
  }
  /** Records the corner points a brush asked the layer to grow to. */
  expandTo(...points: [number, number][]): void {
    expansions.push(points);
  }
  mergeDown(): void {
    const below = this.texture.layers[this.texture.layers.indexOf(this) - 1];
    if (!(below instanceof FakeLayer)) return;
    below.pixels.push(...this.pixels);
    this.remove();
  }
}

/**
 * A Blockbench 5.0/5.1 `TextureLayer` (`js/texturing/layers.js`): no `type`,
 * no `parent_uuid`, and `select()` does not reorder the flat list.
 */
class FakeLegacyLayer extends FakeLayer {
  constructor(data: { name?: string; pixels?: string[] }, texture: FakeTexture) {
    super(data, texture);
    Reflect.deleteProperty(this, "type");
    Reflect.deleteProperty(this, "parent_uuid");
  }
  override select(): void {
    this.texture.selected_layer = this;
  }
}

class FakeGroup extends FakeItem {
  type = "layer_group";
  folded = false;

  get children(): FakeItem[] {
    return this.texture.layers.filter(item => item.parent_uuid === this.uuid);
  }
  getAllChildren(): FakeItem[] {
    return this.children.flatMap(child => (child instanceof FakeGroup ? [child, ...child.getAllChildren()] : [child]));
  }
}

class FakeTexture {
  name = "skin";
  uuid = "texture";
  width = 16;
  height = 16;
  layers_enabled = true;
  selected_layer: FakeItem | null = null;
  layers: FakeItem[] = [];

  select(): void {}
  getActiveLayer(): FakeItem | undefined {
    return this.layers.find(item => item instanceof FakeLayer && item === this.selected_layer) ?? this.layers[0];
  }
  activateLayers(): void {
    this.layers_enabled = true;
    new FakeLayer({ name: "base" }, this).addForEditing();
  }
  updateChangesAfterEdit(): void {}
  updateLayerChanges(): void {}
}

let texture: FakeTexture;

function snapshot(): { enabled: boolean; selected: string | null; layers: ILayerState[] } {
  return {
    enabled: texture.layers_enabled,
    selected: texture.selected_layer?.uuid ?? null,
    layers: texture.layers.map(item => ({
      uuid: item.uuid,
      name: item.name,
      type: item.type,
      parent_uuid: item.parent_uuid,
      visible: item.visible,
      ...(item instanceof FakeLayer ? { opacity: item.opacity, blend_mode: item.blend_mode, pixels: [...item.pixels] } : {}),
      ...(item instanceof FakeGroup ? { folded: item.folded } : {}),
    })),
  };
}

function restore(state: ReturnType<typeof snapshot>): void {
  texture.layers_enabled = state.enabled;
  const items = state.layers.map(data => {
    const item = data.type === "layer_group" ? new FakeGroup(data, texture) : new FakeLayer(data, texture);
    item.uuid = data.uuid;
    item.parent_uuid = data.parent_uuid;
    item.visible = data.visible;
    if (item instanceof FakeGroup) item.folded = Boolean(data.folded);
    return item;
  });
  texture.layers.splice(0, texture.layers.length, ...items);
  texture.selected_layer = items.find(item => item.uuid === state.selected) ?? null;
}

const undo = createUndoHost({ snapshot, restore });

let tools: IToolFixture;

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/paint.ts"], register: ["registerPaintTools"] });
});

/** Builds: base, [Group: a, b], top — flat order bottom to top. */
function buildTexture(): { base: FakeLayer; group: FakeGroup; a: FakeLayer; b: FakeLayer; top: FakeLayer } {
  texture = new FakeTexture();
  const base = new FakeLayer({ name: "base", pixels: ["base"] }, texture);
  const group = new FakeGroup({ name: "Group" }, texture);
  const a = new FakeLayer({ name: "a", pixels: ["a"], parent_uuid: group.uuid }, texture);
  const b = new FakeLayer({ name: "b", pixels: ["b"], parent_uuid: group.uuid }, texture);
  const top = new FakeLayer({ name: "top", pixels: ["top"] }, texture);
  texture.layers.push(base, a, b, group, top);
  texture.selected_layer = top;
  return { base, group, a, b, top };
}

let fixture: ReturnType<typeof buildTexture>;

beforeEach(() => {
  undo.reset();
  stamps = [];
  expansions = [];
  fixture = buildTexture();
});

/** Brush samples stamped by the Painter double, as `x,y` strings. */
let stamps: string[] = [];

/** Corner points passed to `expandTo` by the brush, one entry per call. */
let expansions: [number, number][][] = [];

/** Gives the fake texture the `edit` hook `paint_with_brush` calls. */
function enableTextureEdit(): void {
  Object.assign(texture, {
    edit(callback: (canvas: { getContext(): object }) => void): void {
      callback({ getContext: () => ({}) });
    },
  });
}

useGlobals(() => ({
  BARS: { updateConditions() {} },
  BarItems: {},
  Canvas: { updateAll() {} },
  ColorPanel: { set() {} },
  Painter: {
    current: {},
    editSquare(_ctx: unknown, x: number, y: number): void {
      stamps.push(`${x},${y}`);
    },
  },
  Project: { get textures() { return [texture]; } },
  Texture: { get all() { return [texture]; }, get selected() { return texture; } },
  TextureLayer: FakeLayer,
  TextureLayerGroup: FakeGroup,
  TextureLayerItem: FakeItem,
  UVEditor: { vue: { layer: null } },
  Undo: undo,
  updateInterfacePanels() {},
}));

const names = (): string[] => texture.layers.map(item => item.name);
const call = (input: Record<string, unknown>): Promise<unknown> => tools.call("texture_layer_management", { texture_id: "texture", ...input });

describe("texture_layer_management with 5.2 layer groups", () => {
  test("list_layers reports type, parent and depth without history", async () => {
    const result = await call({ action: "list_layers" });
    const text = JSON.stringify(result);
    expect(text).toContain("layer_group");
    expect(text).toContain(`\\"parent_uuid\\": \\"${fixture.group.uuid}\\"`);
    expect(text).toContain(`\\"depth\\": 1`);
    expect(undo.history).toHaveLength(0);
  });

  test("move_layer reorders among siblings and keeps groups intact", async () => {
    await call({ action: "move_layer", layer_id: "top", target_index: 0 });
    expect(names()).toEqual(["top", "base", "a", "b", "Group"]);
    await call({ action: "move_layer", layer_id: "b", target_index: 0 });
    expect(names()).toEqual(["top", "base", "b", "a", "Group"]);
    expect(undo.history).toHaveLength(2);
  });

  test("create_group nests the given layers and ungroup restores them, each one undo entry", async () => {
    await call({ action: "create_group", layer_name: "Pair", layer_ids: ["base", "top"] });
    const pair = texture.layers.find(item => item.name === "Pair");
    expect(pair?.type).toBe("layer_group");
    expect(fixture.base.parent_uuid).toBe(pair?.uuid ?? "missing");
    expect(names()).toEqual(["a", "b", "Group", "base", "top", "Pair"]);

    await call({ action: "ungroup", layer_id: "Pair" });
    expect(texture.layers.some(item => item.name === "Pair")).toBe(false);
    expect(texture.layers.filter(item => item.parent_uuid === "").map(item => item.name)).toEqual(["Group", "base", "top"]);
    expect(undo.history).toHaveLength(2);

    undo.undo();
    expect(names()).toEqual(["a", "b", "Group", "base", "top", "Pair"]);
  });

  test("move_to_group puts a layer on top of the group and back to the root", async () => {
    await call({ action: "move_to_group", layer_id: "base", group_id: "Group" });
    expect(names()).toEqual(["a", "b", "base", "Group", "top"]);
    await call({ action: "move_to_group", layer_id: "base", group_id: "" });
    expect(fixture.base.parent_uuid).toBe("");
    expect(names()).toEqual(["a", "b", "Group", "base", "top"]);
  });

  test("invalid group moves fail before opening an undo entry", async () => {
    const inner = new FakeGroup({ name: "Inner" }, texture);
    inner.parent_uuid = fixture.group.uuid;
    texture.layers.splice(3, 0, inner);
    await expect(call({ action: "move_to_group", layer_id: "Group", group_id: "Inner" })).rejects.toThrow("cannot contain itself");
    await expect(call({ action: "move_to_group", layer_id: "a", group_id: "top" })).rejects.toThrow("needs a layer group");
    expect(undo.history).toHaveLength(0);
    expect(undo.current_save).toBeUndefined();
  });

  test("merge_down onto a group is reported instead of silently ignored", async () => {
    await expect(call({ action: "merge_down", layer_id: "top" })).rejects.toThrow('layer group "Group"');
    await call({ action: "merge_down", layer_id: "b" });
    expect(fixture.a.pixels).toEqual(["a", "b"]);
    expect(names()).toEqual(["base", "a", "Group", "top"]);
  });

  test("set_opacity stores the 0-100 percentage Blockbench uses", async () => {
    await call({ action: "set_opacity", layer_id: "a", opacity: 40 });
    expect(fixture.a.opacity).toBe(40);
    await expect(call({ action: "set_opacity", layer_id: "Group", opacity: 40 })).rejects.toThrow("needs a pixel layer");
  });

  test("set_blend_mode maps the legacy 'normal' alias to 'default'", async () => {
    await call({ action: "set_blend_mode", layer_id: "a", blend_mode: "multiply" });
    expect(fixture.a.blend_mode).toBe("multiply");
    await call({ action: "set_blend_mode", layer_id: "a", blend_mode: "normal" });
    expect(fixture.a.blend_mode).toBe("default");
  });

  test("duplicate_layer copies a whole group with remapped parents", async () => {
    await call({ action: "duplicate_layer", layer_id: "Group" });
    const copy = texture.layers.find(item => item.name === "Group copy");
    expect(copy).toBeInstanceOf(FakeGroup);
    const copiedChildren = texture.layers.filter(item => item.parent_uuid === copy?.uuid);
    expect(copiedChildren.map(item => item.name)).toEqual(["a", "b"]);
    expect(copiedChildren.every(item => item.uuid !== fixture.a.uuid && item.uuid !== fixture.b.uuid)).toBe(true);
  });

  test("create_layer names count pixel layers only and can target a group", async () => {
    await call({ action: "create_layer", group_id: "Group" });
    const created = texture.layers.find(item => item.name === "Layer 5");
    expect(created?.parent_uuid).toBe(fixture.group.uuid);
    expect(names()).toEqual(["base", "a", "b", "Layer 5", "Group", "top"]);
  });

  test("toggle_visibility on a group applies to all nested layers", async () => {
    await call({ action: "toggle_visibility", layer_id: "Group" });
    expect([fixture.group.visible, fixture.a.visible, fixture.b.visible]).toEqual([false, false, false]);
  });

  test("delete_layer removes a group with its contents but never the last pixel layer", async () => {
    await call({ action: "delete_layer", layer_id: "Group" });
    expect(names()).toEqual(["base", "top"]);
    await call({ action: "delete_layer", layer_id: "base" });
    await expect(call({ action: "delete_layer", layer_id: "top" })).rejects.toThrow("last pixel layer");
  });

  test("flatten_layers disables layers in one undo entry", async () => {
    await call({ action: "flatten_layers" });
    expect(texture.layers_enabled).toBe(false);
    expect(texture.layers).toHaveLength(0);
    undo.undo();
    expect(texture.layers_enabled).toBe(true);
    expect(names()).toEqual(["base", "a", "b", "Group", "top"]);
  });

  test("set_group_folded folds a group", async () => {
    await call({ action: "set_group_folded", layer_id: "Group", folded: true });
    expect(fixture.group.folded).toBe(true);
  });
});

describe("paint target with layer groups", () => {
  test("paint_with_brush switches away from an empty group that getActiveLayer falls back to", async () => {
    // Blockbench's getActiveLayer falls back to layers[0], which can be an empty group without a canvas.
    const empty = new FakeGroup({ name: "Empty" }, texture);
    texture.layers.unshift(empty);
    texture.selected_layer = empty;
    enableTextureEdit();
    await tools.call("paint_with_brush", { texture_id: "texture", coordinates: [{ x: 2, y: 3 }] });
    expect(texture.selected_layer).toBe(fixture.top);
    expect(stamps).toEqual(["2,3"]);
  });

  test("paint_with_brush refuses a texture whose layers are only groups", async () => {
    texture.layers.splice(0, texture.layers.length, fixture.group);
    texture.selected_layer = fixture.group;
    await expect(tools.call("paint_with_brush", { texture_id: "texture", coordinates: [{ x: 0, y: 0 }] })).rejects.toThrow("no pixel layer");
  });

  test("paint_with_brush passes texture coordinates unshifted and grows the layer first", async () => {
    // Painter.scanCanvas subtracts the layer offset itself; subtracting it here too would paint in the wrong place.
    fixture.top.offset = [4, 4];
    // Painter.edit publishes the active layer's offset here, as the real host does.
    Object.assign((Reflect.get(globalThis, "Painter") as { current: object }).current, { offset: [4, 4] });
    enableTextureEdit();
    await tools.call("paint_with_brush", { texture_id: "texture", coordinates: [{ x: 2, y: 3 }], brush_settings: { size: 2 } });
    expect(stamps).toEqual(["2,3"]);
    expect(expansions).toEqual([[[1, 2], [4, 5]]]);
  });
});

describe("texture_layer_management on a host without layer groups (Blockbench 5.0/5.1)", () => {
  let legacy: { base: FakeLegacyLayer; middle: FakeLegacyLayer; top: FakeLegacyLayer };

  beforeEach(() => {
    // 5.0/5.1 have no TextureLayerGroup / TextureLayerItem globals; touching them would throw a ReferenceError.
    Reflect.deleteProperty(globalThis, "TextureLayerGroup");
    Reflect.deleteProperty(globalThis, "TextureLayerItem");
    Reflect.set(globalThis, "TextureLayer", FakeLegacyLayer);
    texture = new FakeTexture();
    legacy = {
      base: new FakeLegacyLayer({ name: "base", pixels: ["base"] }, texture),
      middle: new FakeLegacyLayer({ name: "middle", pixels: ["middle"] }, texture),
      top: new FakeLegacyLayer({ name: "top", pixels: ["top"] }, texture),
    };
    texture.layers.push(legacy.base, legacy.middle, legacy.top);
    texture.selected_layer = legacy.top;
  });

  test("list_layers reports untyped layers as pixel layers", async () => {
    const text = JSON.stringify(await call({ action: "list_layers" }));
    expect(text).toContain(`\\"type\\": \\"pixel_layer\\"`);
    expect(text).not.toContain("layer_group");
  });

  test("select_layer, toggle_visibility and duplicate_layer work on pixel layers", async () => {
    await call({ action: "select_layer", layer_id: "base" });
    expect(texture.selected_layer).toBe(legacy.base);
    await call({ action: "toggle_visibility", layer_id: "middle" });
    expect(legacy.middle.visible).toBe(false);
    await call({ action: "duplicate_layer", layer_id: "base" });
    expect(names()).toEqual(["base", "base copy", "middle", "top"]);
  });

  test("move_layer reorders the flat list without solveLayerOrder", async () => {
    await call({ action: "move_layer", layer_id: "top", target_index: 0 });
    expect(names()).toEqual(["top", "base", "middle"]);
  });

  test("create_layer counts untyped layers and does not add parent_uuid", async () => {
    await call({ action: "create_layer" });
    const created = texture.layers.find(item => item.name === "Layer 4");
    expect(created).toBeInstanceOf(FakeLegacyLayer);
    expect(created ? Object.hasOwn(created, "parent_uuid") : true).toBe(false);
    await expect(call({ action: "create_layer", group_id: "top" })).rejects.toThrow("requires Blockbench 5.2");
  });

  test("group actions are rejected with a version error before opening an undo entry", async () => {
    await expect(call({ action: "create_group", layer_ids: ["base"] })).rejects.toThrow("requires Blockbench 5.2");
    await expect(call({ action: "ungroup", layer_id: "base" })).rejects.toThrow("requires Blockbench 5.2");
    await expect(call({ action: "move_to_group", layer_id: "base", group_id: "" })).rejects.toThrow("requires Blockbench 5.2");
    await expect(call({ action: "set_group_folded", layer_id: "base", folded: true })).rejects.toThrow("requires Blockbench 5.2");
    expect(undo.history).toHaveLength(0);
    expect(undo.current_save).toBeUndefined();
  });

  test("paint_with_brush paints the selected legacy layer", async () => {
    enableTextureEdit();
    await tools.call("paint_with_brush", { texture_id: "texture", coordinates: [{ x: 1, y: 1 }] });
    expect(texture.selected_layer).toBe(legacy.top);
    expect(stamps).toEqual(["1,1"]);
  });
});
