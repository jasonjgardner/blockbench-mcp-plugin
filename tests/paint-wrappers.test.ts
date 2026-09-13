import { beforeAll, beforeEach, expect, test } from "bun:test";
import { registerPaintTools } from "@/server/tools/paint";
import { required } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { evaluateHostCondition } from "@/tests/helpers/condition-host";
import { executeTool } from "@/tests/helpers/tool-execution";
import { createUndoHost } from "@/tests/helpers/undo-host";

/** Stroke context Painter keeps from the last viewport raycast; texture-coordinate strokes must clear it. */
interface IPainterContext {
  element?: unknown;
  face?: unknown;
  face_matrices?: unknown;
}

/** Synthetic pointer event the paint wrappers pass to `Painter.startPaintTool`. */
interface IPaintEvent {
  ctrlOrCmd?: boolean;
}

/**
 * The part of `HTMLCanvasElement` that `paint_with_brush` touches inside `Texture.edit`.
 * The texture double is installed as an untyped global, so this structural stub needs no DOM cast.
 */
interface ICanvasStub {
  getContext(contextId: string): object;
}

const BRUSH_SETTING_KEYS = [
  "slider_brush_size",
  "slider_brush_opacity",
  "slider_brush_softness",
  "brush_shape",
  "fill_mode",
  "blend_mode",
  "draw_shape_type",
  "copy_brush_mode",
] as const;
const PAINT_TOOL_KEYS = ["fill_tool", "draw_shape_tool", "gradient_tool", "copy_brush", "eraser"] as const;

let pixels: string[];
let strokeTool: string;
let cancelStroke: boolean;
let failStroke: boolean;
let unchangedStroke: boolean;
let starts: number;
let stops: number;

const undo = createUndoHost<readonly string[]>({
  restore: (target) => {
    pixels = [...target];
  },
  snapshot: () => [...pixels],
});

function createCanvasStub(): ICanvasStub {
  return { getContext: () => ({}) };
}

function emptyPainterContext(): IPainterContext {
  return {};
}

const texture = {
  name: "test",
  uuid: "texture",
  select(): void {},
  edit(callback: (canvas: ICanvasStub) => void): void {
    undo.initEdit();
    callback(createCanvasStub());
    undo.finishEdit();
  },
};

const painter = {
  paint_stroke_canceled: false,
  brushChanges: false,
  current: emptyPainterContext(),
  startPaintTool(_texture: unknown, x: number, y: number, uv: unknown, event: IPaintEvent): void {
    starts++;
    this.paint_stroke_canceled = cancelStroke || !!event.ctrlOrCmd;
    if (this.paint_stroke_canceled) return;
    undo.initEdit();
    this.brushChanges = false;
    // Native setupRectFromFace treats a truthy empty object as a mesh UV map
    // with no vertices, yielding [width,height,0,0] and no paintable pixels.
    const emptyFace = !!uv && typeof uv === "object" && !Object.keys(uv).length;
    if (!unchangedStroke && !emptyFace && !this.current.element) {
      pixels.push(`${strokeTool}:${x},${y}`);
      this.brushChanges = true;
    }
    if (failStroke) throw new Error("Pixel write failed");
  },
  movePaintTool(_texture: unknown, x: number, y: number): void {
    pixels.push(`move:${x},${y}`);
    this.brushChanges = true;
  },
  useShapeTool(): void {
    pixels.push("shape");
    this.brushChanges = true;
  },
  useGradientTool(): void {
    pixels.push("gradient");
    this.brushChanges = true;
  },
  stopPaintTool(): void {
    stops++;
    if (this.paint_stroke_canceled) {
      this.paint_stroke_canceled = false;
      return;
    }
    if (this.brushChanges) undo.finishEdit();
    this.brushChanges = false;
  },
  editCircle(_context: unknown, x: number, y: number): void {
    pixels.push(`circle:${x},${y}`);
  },
  editSquare(_context: unknown, x: number, y: number): void {
    pixels.push(`square:${x},${y}`);
  },
};

function createBarItems(): Record<string, unknown> {
  const settings = Object.fromEntries(BRUSH_SETTING_KEYS.map(key => [key, { value: 0, set() {} }]));
  const tools = Object.fromEntries(PAINT_TOOL_KEYS.map(key => [key, { condition: { modes: ["paint"] }, select() { strokeTool = key; } }]));
  return { ...settings, ...tools };
}

beforeAll(() => registerPaintTools());
beforeEach(() => {
  pixels = ["original"];
  strokeTool = "";
  cancelStroke = false;
  failStroke = false;
  unchangedStroke = false;
  starts = 0;
  stops = 0;
  undo.reset();
  painter.paint_stroke_canceled = false;
  painter.brushChanges = false;
  painter.current = emptyPainterContext();
});
useGlobals(() => ({
  Condition: evaluateHostCondition,
  BarItems: createBarItems(),
  Canvas: { updateAll() {} },
  ColorPanel: { set() {} },
  Painter: painter,
  Project: { textures: [texture] },
  Format: { paint_mode: true },
  Modes: { id: "paint" },
  Texture: { all: [texture], selected: texture },
  Undo: undo,
}));

const defaults = { texture_id: "texture", x: 1, y: 1, color: "#ff0000", opacity: 255, start: { x: 1, y: 1 }, end: { x: 3, y: 3 } };
const squareBrush = { color: "#ff0000", size: 1, opacity: 255, softness: 0, shape: "square" };

test.each([
  ["paint_fill_tool", defaults],
  ["draw_shape_tool", { ...defaults, shape: "rectangle" }],
  ["gradient_tool", { ...defaults, start_color: "#ff0000", end_color: "#0000ff" }],
  ["copy_brush_tool", { ...defaults, source: { x: 0, y: 0 }, target: { x: 2, y: 2 }, brush_size: 1 }],
] as const)("%s lets native Painter own one reversible edit", async (name, args) => {
  await executeTool(name, args);
  expect(undo.history).toHaveLength(1);
  expect(undo.current_save).toBeUndefined();
  const after = [...pixels];
  expect(after).not.toEqual(["original"]);
  undo.undo();
  expect(pixels).toEqual(["original"]);
  undo.redo();
  expect(pixels).toEqual(after);
});

test.each([true, false])("eraser connect_strokes=%s has balanced native stroke transactions", async connect => {
  await executeTool("eraser_tool", { texture_id: "texture", coordinates: [{ x: 1, y: 1 }, { x: 5, y: 5 }], brush_size: 1, opacity: 255, softness: 0, connect_strokes: connect });
  expect(undo.history).toHaveLength(connect ? 1 : 2);
  expect(starts).toBe(connect ? 1 : 2);
  expect(stops).toBe(starts);
  expect(undo.current_save).toBeUndefined();
  expect(pixels).not.toEqual(["original"]);
  // Undo.undo() only reverts the latest stroke; the first entry's snapshot proves the whole erase is reversible.
  pixels = [...required(undo.history.at(0), "first eraser stroke").before];
  expect(pixels).toEqual(["original"]);
});

test("unchanged native strokes discard the uncommitted snapshot", async () => {
  unchangedStroke = true;
  await executeTool("paint_fill_tool", defaults);
  expect(undo.current_save).toBeUndefined();
  expect(undo.history).toHaveLength(0);
});

test("canceled and failed native strokes return errors without partial pixels/history", async () => {
  cancelStroke = true;
  await expect(executeTool("paint_fill_tool", defaults)).rejects.toThrow("canceled");
  cancelStroke = false;
  failStroke = true;
  await expect(executeTool("paint_fill_tool", defaults)).rejects.toThrow("Pixel write failed");
  expect(pixels).toEqual(["original"]);
  expect(undo.current_save).toBeUndefined();
  expect(undo.history).toHaveLength(0);
});

test("paint_with_brush lets Texture.edit own its transaction", async () => {
  await executeTool("paint_with_brush", { texture_id: "texture", coordinates: [{ x: 1, y: 1 }], brush_settings: squareBrush });
  expect(undo.history).toHaveLength(1);
  expect(undo.history[0].before).toEqual(["original"]);
  expect(undo.history[0].after).toEqual(["original", "square:1,1"]);
});

test.each([true, false])("paint_with_brush connect_strokes=%s controls intermediate brush samples", async connect => {
  await executeTool("paint_with_brush", { texture_id: "texture", coordinates: [{ x: 1, y: 1 }, { x: 4, y: 1 }], connect_strokes: connect, brush_settings: squareBrush });
  expect(pixels).toEqual(connect ? ["original", "square:1,1", "square:2,1", "square:3,1", "square:4,1"] : ["original", "square:1,1", "square:4,1"]);
  expect(undo.history).toHaveLength(1);
  expect(undo.history[0].before).toEqual(["original"]);
});

test("unsupported nonzero fill tolerance is rejected before texture activation or Undo", async () => {
  await expect(executeTool("paint_fill_tool", { ...defaults, tolerance: 25 })).rejects.toThrow("exact color matching");
  expect(pixels).toEqual(["original"]);
  expect(starts).toBe(0);
  expect(undo.current_save).toBeUndefined();
});

test("texture-coordinate strokes discard stale viewport face restrictions", async () => {
  painter.current = { element: { uuid: "unrelated viewport mesh" }, face: "old-face", face_matrices: { "old-face": {} } };
  await executeTool("paint_fill_tool", defaults);
  expect(pixels).not.toEqual(["original"]);
  expect(painter.current).toEqual({});
  expect(undo.history).toHaveLength(1);
});
