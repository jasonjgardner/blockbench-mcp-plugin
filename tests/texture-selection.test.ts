import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { SELECTION_NOT_RECORDED_NOTE } from "@/server/tools/paint/selection-tools";

/** Blockbench 5.2's per-pixel `IntMatrix` selection, reduced to what the tool calls. */
class TestSelection {
  override: boolean | null = false;
  private readonly pixels = new Map<string, number>();
  get(x: number, y: number): number | boolean {
    return this.override ?? (this.pixels.get(`${x},${y}`) ?? 0);
  }
  set(x: number, y: number, value: number): void {
    this.override = null;
    this.pixels.set(`${x},${y}`, value);
  }
  clear(): void {
    this.pixels.clear();
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

/** The selection-history calls the tool made, in order. */
let undoCalls: string[];
let texture: TestTexture;
let selectedTexture: TestTexture | undefined;
let uvEditorTexture: TestTexture | null;
let undoSelections: boolean;
let tools: IToolFixture;

beforeAll(async () => {
  tools = await loadToolDefinitions({
    entries: ["server/tools/paint/selection-tools.ts"],
    register: ["registerTextureSelectionTool"],
  });
});

beforeEach(() => {
  undoCalls = [];
  texture = new TestTexture("skin", "skin-uuid");
  selectedTexture = texture;
  uvEditorTexture = texture;
  undoSelections = true;
});

useGlobals(() => ({
  Project: { get textures() { return [texture]; } },
  Texture: {
    get all() { return [texture]; },
    get selected() { return selectedTexture; },
    getDefault: () => texture,
  },
  settings: { undo_selections: { get value() { return undoSelections; } } },
  UVEditor: { get texture() { return uvEditorTexture; }, vue: { updateTexture() {} } },
  Undo: {
    initSelection() { undoCalls.push("init"); return {}; },
    finishSelection(label: string) { undoCalls.push(`finish:${label}`); },
    cancelSelection() { undoCalls.push("cancel"); },
  },
}));

const selectRectangle = { action: "select_rectangle", coordinates: { x1: 1, y1: 1, x2: 2, y2: 2 } };

describe("texture_selection undo", () => {
  test("records one selection entry when the UV editor shows the texture", async () => {
    const result = await tools.call("texture_selection", selectRectangle);
    expect(undoCalls).toEqual(["init", "finish:Texture selection"]);
    expect(String(result)).not.toContain(SELECTION_NOT_RECORDED_NOTE);
    expect(texture.selection.get(1, 1)).toBe(1);
  });

  test("applies the change without an entry, and says so, when the UV editor shows another texture", async () => {
    uvEditorTexture = null;
    const result = await tools.call("texture_selection", selectRectangle);
    expect(undoCalls).toEqual([]);
    expect(String(result)).toContain(SELECTION_NOT_RECORDED_NOTE);
    expect(texture.selection.get(2, 2)).toBe(1);
    expect(texture.selection.get(0, 0)).toBe(0);
  });

  test("leaves recording to Blockbench when Undo Selection is off", async () => {
    undoSelections = false;
    uvEditorTexture = null;
    const result = await tools.call("texture_selection", selectRectangle);
    expect(undoCalls).toEqual(["init", "finish:Texture selection"]);
    expect(String(result)).not.toContain(SELECTION_NOT_RECORDED_NOTE);
  });
});
