import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { getAllToolDefinitions } from "@/lib/factories";
import { registerPaintTools } from "@/server/tools/paint";

let pixels: string[];
let strokeTool: string;
let cancelStroke: boolean;
let failStroke: boolean;
let unchangedStroke: boolean;
let starts: number;
let stops: number;
const texture = { uuid: "texture", name: "test", select() {}, edit(callback: (canvas: HTMLCanvasElement) => void): void {
  undo.initEdit(); callback({ getContext: () => ({}) } as unknown as HTMLCanvasElement); undo.finishEdit();
} };
const undo = {
  current_save: undefined as string[] | undefined,
  history: [] as Array<{ before: string[]; after: string[] }>,
  initEdit(): void {
    if (this.current_save) throw new Error("Nested undo transaction");
    this.current_save = [...pixels];
  },
  finishEdit(): void {
    if (!this.current_save) throw new Error("No pending transaction");
    this.history.push({ before: this.current_save, after: [...pixels] });
    this.current_save = undefined;
  },
  cancelEdit(revert: boolean): void { if (revert && this.current_save) pixels = [...this.current_save]; this.current_save = undefined; },
};
const painter = {
  paint_stroke_canceled: false,
  brushChanges: false,
  current: {} as { element?: unknown; face?: unknown; face_matrices?: unknown },
  startPaintTool(_texture: unknown, x: number, y: number, _uv: unknown, event: { ctrlOrCmd?: boolean }): void {
    starts++;
    this.paint_stroke_canceled = cancelStroke || !!event.ctrlOrCmd;
    if (this.paint_stroke_canceled) return;
    undo.initEdit();
    this.brushChanges = false;
    // Native setupRectFromFace treats a truthy empty object as a mesh UV map
    // with no vertices, yielding [width,height,0,0] and no paintable pixels.
    const emptyFace = !!_uv && typeof _uv === "object" && !Object.keys(_uv).length;
    if (!unchangedStroke && !emptyFace && !this.current.element) { pixels.push(`${strokeTool}:${x},${y}`); this.brushChanges = true; }
    if (failStroke) throw new Error("Pixel write failed");
  },
  movePaintTool(_texture: unknown, x: number, y: number): void { pixels.push(`move:${x},${y}`); this.brushChanges = true; },
  useShapeTool(): void { pixels.push("shape"); this.brushChanges = true; },
  useGradientTool(): void { pixels.push("gradient"); this.brushChanges = true; },
  stopPaintTool(): void {
    stops++;
    if (this.paint_stroke_canceled) { this.paint_stroke_canceled = false; return; }
    if (this.brushChanges) undo.finishEdit();
    this.brushChanges = false;
  },
  editCircle(_context: unknown, x: number, y: number): void { pixels.push(`circle:${x},${y}`); },
  editSquare(_context: unknown, x: number, y: number): void { pixels.push(`square:${x},${y}`); },
};
const keys = ["Undo", "Project", "Texture", "Painter", "Canvas", "ColorPanel", "BarItems"];
const original = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => { keys.forEach(key => original.set(key, Object.getOwnPropertyDescriptor(globalThis, key))); registerPaintTools(); });
beforeEach(() => {
  pixels = ["original"];
  strokeTool = "";
  cancelStroke = false;
  failStroke = false;
  unchangedStroke = false;
  starts = 0;
  stops = 0;
  undo.current_save = undefined;
  undo.history = [];
  painter.paint_stroke_canceled = false;
  painter.brushChanges = false;
  painter.current = {};
  const settings = Object.fromEntries(["slider_brush_size", "slider_brush_opacity", "slider_brush_softness", "brush_shape", "fill_mode", "blend_mode", "draw_shape_type", "copy_brush_mode"].map(key => [key, { value: 0, set() {} }]));
  const tools = Object.fromEntries(["fill_tool", "draw_shape_tool", "gradient_tool", "copy_brush", "eraser"].map(key => [key, { select() { strokeTool = key; } }]));
  Object.assign(globalThis, { Undo: undo, Project: { textures: [texture] }, Texture: { selected: texture }, Painter: painter, Canvas: { updateAll() {} }, ColorPanel: { set() {} }, BarItems: { ...settings, ...tools } });
});
afterAll(() => original.forEach((descriptor, key) => {
  if (descriptor) { Object.defineProperty(globalThis, key, descriptor); return; }
  Reflect.deleteProperty(globalThis, key);
}));
async function execute(name: string, input: Record<string, unknown>): Promise<unknown> {
  const tool = getAllToolDefinitions()[name];
  return tool.execute(tool.parameterSchema.parse(input));
}
const defaults = { texture_id: "texture", x: 1, y: 1, color: "#ff0000", opacity: 255, start: { x: 1, y: 1 }, end: { x: 3, y: 3 } };
test.each([
  ["paint_fill_tool", defaults],
  ["draw_shape_tool", { ...defaults, shape: "rectangle" }],
  ["gradient_tool", { ...defaults, start_color: "#ff0000", end_color: "#0000ff" }],
  ["copy_brush_tool", { ...defaults, source: { x: 0, y: 0 }, target: { x: 2, y: 2 }, brush_size: 1 }],
] as const)("%s lets native Painter own one reversible edit", async (name, args) => {
  await execute(name, args);
  expect(undo.history).toHaveLength(1);
  expect(undo.current_save).toBeUndefined();
  const after = [...pixels];
  expect(after).not.toEqual(["original"]);
  pixels = [...undo.history[0].before];
  expect(pixels).toEqual(["original"]);
  pixels = [...undo.history[0].after];
  expect(pixels).toEqual(after);
});
test.each([true, false])("eraser connect_strokes=%s has balanced native stroke transactions", async connect => {
  await execute("eraser_tool", { texture_id: "texture", coordinates: [{ x: 1, y: 1 }, { x: 5, y: 5 }], brush_size: 1, opacity: 255, softness: 0, connect_strokes: connect });
  expect(undo.history).toHaveLength(connect ? 1 : 2);
  expect(starts).toBe(connect ? 1 : 2);
  expect(stops).toBe(starts);
  expect(undo.current_save).toBeUndefined();
  expect(pixels).not.toEqual(["original"]);
  pixels = [...undo.history[0].before];
  expect(pixels).toEqual(["original"]);
});
test("unchanged native strokes discard the uncommitted snapshot", async () => {
  unchangedStroke = true;
  await execute("paint_fill_tool", defaults);
  expect(undo.current_save).toBeUndefined();
  expect(undo.history).toHaveLength(0);
});
test("canceled and failed native strokes return errors without partial pixels/history", async () => {
  cancelStroke = true;
  await expect(execute("paint_fill_tool", defaults)).rejects.toThrow("canceled");
  cancelStroke = false;
  failStroke = true;
  await expect(execute("paint_fill_tool", defaults)).rejects.toThrow("Pixel write failed");
  expect(pixels).toEqual(["original"]);
  expect(undo.current_save).toBeUndefined();
  expect(undo.history).toHaveLength(0);
});
test("paint_with_brush lets Texture.edit own its transaction", async () => {
  await execute("paint_with_brush", { texture_id: "texture", coordinates: [{ x: 1, y: 1 }], brush_settings: { color: "#ff0000", size: 1, opacity: 255, softness: 0, shape: "square" } });
  expect(undo.history).toHaveLength(1);
  expect(undo.history[0].before).toEqual(["original"]);
  expect(undo.history[0].after).toEqual(["original", "square:1,1"]);
});
test.each([true, false])("paint_with_brush connect_strokes=%s controls intermediate brush samples", async connect => {
  await execute("paint_with_brush", { texture_id: "texture", coordinates: [{ x: 1, y: 1 }, { x: 4, y: 1 }], connect_strokes: connect, brush_settings: { color: "#ff0000", size: 1, opacity: 255, softness: 0, shape: "square" } });
  expect(pixels).toEqual(connect ? ["original", "square:1,1", "square:2,1", "square:3,1", "square:4,1"] : ["original", "square:1,1", "square:4,1"]);
  expect(undo.history).toHaveLength(1);
  expect(undo.history[0].before).toEqual(["original"]);
});
test("unsupported nonzero fill tolerance is rejected before texture activation or Undo", async () => {
  await expect(execute("paint_fill_tool", { ...defaults, tolerance: 25 })).rejects.toThrow("exact color matching");
  expect(pixels).toEqual(["original"]);
  expect(starts).toBe(0);
  expect(undo.current_save).toBeUndefined();
});
test("texture-coordinate strokes discard stale viewport face restrictions", async () => {
  painter.current = { element: { uuid: "unrelated viewport mesh" }, face: "old-face", face_matrices: { "old-face": {} } };
  await execute("paint_fill_tool", defaults);
  expect(pixels).not.toEqual(["original"]);
  expect(painter.current).toEqual({});
  expect(undo.history).toHaveLength(1);
});
