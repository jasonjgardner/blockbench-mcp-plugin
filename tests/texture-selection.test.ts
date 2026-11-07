import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";

/** Blockbench 5.2's per-pixel `IntMatrix` selection, reduced to what the tool calls. */
class TestSelection {
  width = 4;
  height = 4;
  override: boolean | null = false;
  array?: Int8Array;
  get is_custom(): boolean { return this.override === null; }
  get(x: number, y: number): number | boolean {
    return this.override ?? (this.array?.[y * this.width + x] ?? 0);
  }
  set(x: number, y: number, value: number): void {
    if (!this.array) this.array = new Int8Array(this.width * this.height);
    if (this.override !== null) this.array.fill(this.override ? 1 : 0);
    this.override = null;
    this.array[y * this.width + x] = value;
  }
  clear(): void {
    this.array = undefined;
    this.override = false;
  }
  setOverride(value: boolean | null): void {
    this.override = value;
  }
}

class TestTexture {
  readonly selection = new TestSelection();
  readonly width = 4;
  readonly height = 4;
  constructor(readonly name: string, readonly uuid: string) {}
  get id(): string { return this.name; }
  select(): void { selectedTexture = this; }
}

/** Native Undo/Redo require selection saves to inherit from this constructor. */
class TestSelectionSave {
  constructor(readonly aspects: object = {}) {}
  load(): void { throw new Error("Native UV-editor-only restoration must not run."); }
  matches(_other: TestSelectionSave): boolean { return false; }
}
interface ISelectionEntry {
  selection_before: TestSelectionSave;
  selection_post: TestSelectionSave;
  action: string;
  type: string;
  time: number;
}

let undoCalls: string[];
let texture: TestTexture;
let textures: TestTexture[];
let selectedTexture: TestTexture | undefined;
let uvEditorTexture: TestTexture | null;
let undoSelections: boolean;
let undoLimit: number;
let editSession: object | undefined;
let loadingSelection: boolean;
let outlineUpdates: number;
let tools: IToolFixture;
const undo = {
  history: [] as ISelectionEntry[],
  index: 0,
  current_selection_save: undefined as TestSelectionSave | undefined,
  cancelSelection(revert = false): void {
    if (revert) this.current_selection_save?.load();
    delete this.current_selection_save;
    undoCalls.push("cancel_selection_change");
  },
  // Mirror the selection branch of native UndoSystem.undo/redo.
  undo(): void {
    if (this.index < 1) return;
    const entry = this.history[--this.index];
    if (entry.selection_before instanceof TestSelectionSave) entry.selection_before.load();
  },
  redo(): void {
    if (this.index >= this.history.length) return;
    const entry = this.history[this.index++];
    if (entry.selection_post instanceof TestSelectionSave) entry.selection_post.load();
  },
};

beforeAll(async () => {
  tools = await loadToolDefinitions({
    entries: ["server/tools/paint/selection-tools.ts"],
    register: ["registerTextureSelectionTool"],
  });
});

beforeEach(() => {
  undoCalls = [];
  texture = new TestTexture("skin", "skin-uuid");
  textures = [texture];
  selectedTexture = texture;
  uvEditorTexture = texture;
  undoSelections = true;
  undoLimit = 256;
  editSession = undefined;
  loadingSelection = false;
  outlineUpdates = 0;
  undo.history = [];
  undo.index = 0;
  delete undo.current_selection_save;
});

useGlobals(() => ({
  Project: { get textures() { return textures; }, get EditSession() { return editSession; } },
  Texture: {
    get all() { return textures; },
    get selected() { return selectedTexture; },
    getDefault: () => texture,
  },
  settings: {
    undo_selections: { get value() { return undoSelections; } },
    undo_limit: { get value() { return undoLimit; } },
  },
  UVEditor: {
    get texture() { return uvEditorTexture; },
    updateSelectionOutline() { outlineUpdates++; },
    vue: { updateTexture() {} },
  },
  Blockbench: {
    hasFlag: (flag: string) => flag === "loading_selection_save" && loadingSelection,
    dispatchEvent: (name: string) => { undoCalls.push(name); },
  },
  UndoSystem: { selectionSave: TestSelectionSave },
  Undo: undo,
}));

const selectRectangle = { action: "select_rectangle", coordinates: { x1: 1, y1: 1, x2: 2, y2: 2 } };

describe("texture_selection undo", () => {
  test("records one selection entry when the UV editor shows the texture", async () => {
    const result = await tools.call("texture_selection", selectRectangle);
    expect(undoCalls).toEqual(["init_selection_change", "finish_selection_change", "finished_selection_change"]);
    expect(String(result)).toBe('Applied select_rectangle to texture "skin"');
    expect(undo.history).toHaveLength(1);
    expect(undo.history[0]).toMatchObject({ action: "Texture selection", type: "selection" });
    expect(undo.history[0].time).toBeGreaterThan(0);
    expect(undo.current_selection_save).toBeUndefined();
    expect(texture.selection.get(1, 1)).toBe(1);
    undo.undo();
    expect(texture.selection.override).toBe(false);
    undo.redo();
    expect(texture.selection.get(1, 1)).toBe(1);
    expect(outlineUpdates).toBe(2);
  });

  test("Undo/Redo restores the target in Edit mode with no texture in the UV editor", async () => {
    uvEditorTexture = null;
    await tools.call("texture_selection", selectRectangle);
    expect(undo.history).toHaveLength(1);
    expect(texture.selection.get(2, 2)).toBe(1);
    expect(texture.selection.get(0, 0)).toBe(0);
    undo.undo();
    expect(texture.selection.override).toBe(false);
    expect(textures).toEqual([texture]);
    undo.redo();
    expect(texture.selection.get(2, 2)).toBe(1);
    expect(outlineUpdates).toBe(0);
  });

  test("never restores the UV editor's unrelated texture or changes the active texture", async () => {
    const other = new TestTexture("other", "other-uuid");
    other.selection.setOverride(true);
    textures.push(other);
    uvEditorTexture = other;
    await tools.call("texture_selection", selectRectangle);
    selectedTexture = other;
    undo.undo();
    undo.redo();
    expect(texture.selection.get(2, 2)).toBe(1);
    expect(other.selection.override).toBe(true);
    expect(selectedTexture).toBe(other);
    expect(outlineUpdates).toBe(0);
  });

  test.each(["disabled", "session", "loading", "pending"])("records nothing with the native %s guard", async guard => {
    if (guard === "disabled") undoSelections = false;
    if (guard === "session") editSession = {};
    if (guard === "loading") loadingSelection = true;
    const pending = guard === "pending" ? new TestSelectionSave() : undefined;
    undo.current_selection_save = pending;
    await tools.call("texture_selection", selectRectangle);
    expect(undo.history).toHaveLength(0);
    expect(undoCalls).toEqual([]);
    expect(texture.selection.get(2, 2)).toBe(1);
    expect(undo.current_selection_save).toBe(pending);
  });

  test("restores both uniform overrides and copies custom masks without aliasing", async () => {
    await tools.call("texture_selection", { action: "select_all" });
    await tools.call("texture_selection", selectRectangle);
    const mask = new Int8Array(texture.selection.array!);
    await tools.call("texture_selection", { action: "clear_selection" });
    undo.undo();
    expect(texture.selection.array).toEqual(mask);
    texture.selection.array!.fill(0);
    undo.undo();
    expect(texture.selection.override).toBe(true);
    undo.redo();
    expect(texture.selection.array).toEqual(mask);
    undo.redo();
    expect(texture.selection.override).toBe(false);
  });

  test("matches unchanged masks and overrides without discarding the redo branch", async () => {
    await tools.call("texture_selection", selectRectangle);
    await tools.call("texture_selection", selectRectangle);
    expect(undo.history).toHaveLength(1);
    undo.undo();
    await tools.call("texture_selection", { action: "clear_selection" });
    expect(undo.history).toHaveLength(1);
    expect(undo.index).toBe(0);
    expect(undoCalls.at(-1)).toBe("cancel_selection_change");
    undo.redo();
    expect(texture.selection.get(2, 2)).toBe(1);
  });

  test("trims the redo branch before appending a new selection entry", async () => {
    await tools.call("texture_selection", selectRectangle);
    await tools.call("texture_selection", { action: "select_all" });
    undo.undo();
    const discarded = undo.history[1];
    await tools.call("texture_selection", { action: "clear_selection" });
    expect(undo.history).toHaveLength(2);
    expect(undo.history[1]).not.toBe(discarded);
    expect(undo.index).toBe(2);
    undo.undo();
    expect(texture.selection.get(2, 2)).toBe(1);
    undo.redo();
    expect(texture.selection.override).toBe(false);
  });

  test("honors the native undo limit", async () => {
    undoLimit = 1;
    await tools.call("texture_selection", selectRectangle);
    await tools.call("texture_selection", { action: "select_all" });
    expect(undo.history).toHaveLength(1);
    expect(undo.index).toBe(1);
    undo.undo();
    expect(texture.selection.get(2, 2)).toBe(1);
    expect(texture.selection.get(0, 0)).toBe(0);
  });

  test("finds a recreated texture by UUID and tolerates a deleted target", async () => {
    await tools.call("texture_selection", selectRectangle);
    const replacement = new TestTexture("renamed", texture.uuid);
    textures = [replacement];
    undo.undo();
    undo.redo();
    expect(replacement.selection.get(2, 2)).toBe(1);
    textures = [];
    expect(() => undo.undo()).not.toThrow();
    expect(() => undo.redo()).not.toThrow();
  });

  test("reallocates an incompatible mask buffer without sharing the snapshot", async () => {
    await tools.call("texture_selection", selectRectangle);
    undo.undo();
    texture.selection.array = new Int8Array(1);
    undo.redo();
    expect(texture.selection.array).toHaveLength(16);
    expect(texture.selection.get(2, 2)).toBe(1);
    texture.selection.array!.fill(0);
    undo.undo();
    undo.redo();
    expect(texture.selection.get(2, 2)).toBe(1);
  });

  test("does not install a saved mask on a texture recreated at an incompatible size", async () => {
    await tools.call("texture_selection", selectRectangle);
    undo.undo();
    const replacement = new TestTexture("resized", texture.uuid);
    replacement.selection.width = 2;
    replacement.selection.height = 2;
    replacement.selection.setOverride(true);
    textures = [replacement];
    undo.redo();
    expect(replacement.selection.override).toBe(true);
    expect(replacement.selection.array).toBeUndefined();
  });

  test.each([false, true])("rolls back a partial mask failure (custom before: %s)", async custom => {
    if (custom) texture.selection.set(0, 0, 1);
    const before = texture.selection.array && new Int8Array(texture.selection.array);
    const set = texture.selection.set.bind(texture.selection);
    texture.selection.set = (x, y, value) => {
      set(x, y, value);
      if (x === 2 && y === 1) throw new Error("mask write failed");
    };
    await expect(tools.call("texture_selection", selectRectangle)).rejects.toThrow("mask write failed");
    expect(undo.history).toHaveLength(0);
    expect(undo.current_selection_save).toBeUndefined();
    expect(texture.selection.override).toBe(custom ? null : false);
    if (custom) expect(texture.selection.array).toEqual(before);
    expect(undoCalls).toEqual(["init_selection_change", "cancel_selection_change"]);
  });
});
