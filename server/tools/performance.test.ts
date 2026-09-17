import { beforeAll, beforeEach, expect, test } from "bun:test";
import { DEFAULT_FPS_SAMPLE_MS, MAX_FPS_SAMPLE_MS, MIN_FPS_SAMPLE_MS, performanceToolDocs, registerPerformanceTools } from "@/server/tools/performance";
import { isRecord } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { executeStructured, executeTool } from "@/tests/helpers/tool-execution";

type Handler = (data: Record<string, unknown>) => void;

interface IFpsResult {
  average_fps: number;
  frames: number;
  elapsed_ms: number;
  fps_limit: number | null;
  last_second_fps: number | null;
  focus_changed: boolean;
  rendering_paused: boolean;
}

const listeners = new Map<string, Set<Handler>>();
let ticker: ReturnType<typeof setInterval> | undefined;

/** Emits `render_frame` every few milliseconds, like Blockbench's animation loop, until the listener is gone. */
function startRenderLoop(intervalMs: number): void {
  ticker = setInterval(() => {
    listeners.get("render_frame")?.forEach(listener => listener({}));
  }, intervalMs);
}

beforeAll(() => registerPerformanceTools());
beforeEach(() => {
  listeners.clear();
  clearInterval(ticker);
});
useGlobals(() => ({
  Blockbench: {
    on(name: string, handler: Handler): void {
      listeners.set(name, new Set([...(listeners.get(name) ?? []), handler]));
    },
    removeListener(name: string, handler: Handler): void {
      listeners.get(name)?.delete(handler);
    },
  },
  Prop: { fps: 57 },
  settings: { fps_limit: { value: 60 }, background_rendering: { value: true } },
}));

const isFpsResult = (value: unknown): value is IFpsResult =>
  isRecord(value) && typeof value.average_fps === "number" && typeof value.frames === "number" && typeof value.elapsed_ms === "number";

test("get_average_fps is documented as a read-only experimental tool with a bounded window", () => {
  const [spec] = performanceToolDocs;
  expect(spec.name).toBe("get_average_fps");
  expect(spec.annotations?.readOnlyHint).toBe(true);
  expect(spec.parameters.parse({})).toEqual({ duration_ms: DEFAULT_FPS_SAMPLE_MS });
  expect(() => spec.parameters.parse({ duration_ms: MIN_FPS_SAMPLE_MS - 1 })).toThrow();
  expect(() => spec.parameters.parse({ duration_ms: MAX_FPS_SAMPLE_MS + 1 })).toThrow();
  expect(() => spec.parameters.parse({ duration_ms: 250.5 })).toThrow();
});

test("get_average_fps counts frames rendered during the window and reports the host context", async () => {
  startRenderLoop(5);
  const result = await executeStructured("get_average_fps", { duration_ms: MIN_FPS_SAMPLE_MS }, isFpsResult);
  clearInterval(ticker);
  expect(result.frames).toBeGreaterThan(0);
  expect(result.elapsed_ms).toBeGreaterThanOrEqual(MIN_FPS_SAMPLE_MS);
  // elapsed_ms is rounded in the result, so compare within half a frame per second rather than re-deriving the rounding.
  expect(result.average_fps).toBeCloseTo(result.frames / (result.elapsed_ms / 1000), 0);
  expect(result.fps_limit).toBe(60);
  expect(result.last_second_fps).toBe(57);
  expect(result.focus_changed).toBe(false);
  expect(result.rendering_paused).toBe(false);
  expect(listeners.get("render_frame")?.size ?? 0).toBe(0);
});

test("get_average_fps reports zero frames without a render loop and leaves no listener behind", async () => {
  const result = await executeStructured("get_average_fps", { duration_ms: MIN_FPS_SAMPLE_MS }, isFpsResult);
  expect(result.frames).toBe(0);
  expect(result.average_fps).toBe(0);
  expect(result.rendering_paused).toBe(false);
  expect(listeners.get("render_frame")?.size ?? 0).toBe(0);
});

test("get_average_fps rejects windows outside the allowed range before touching the host", async () => {
  await expect(executeTool("get_average_fps", { duration_ms: 0 })).rejects.toThrow();
  expect(listeners.size).toBe(0);
});
