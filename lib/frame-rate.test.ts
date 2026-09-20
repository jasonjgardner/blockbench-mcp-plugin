import { expect, test } from "bun:test";
import { readDocumentHidden, readFrameRateContext, readWindowFocus, sampleRenderFrames, summarizeFrameRate, type IFrameRateContext, type IRenderFrameHost, type IVisibilityHost } from "@/lib/frame-rate";
import { installGlobals, useGlobals } from "@/tests/helpers/globals";

type Handler = () => void;

/** Event host whose listeners the test drives by hand. */
function createHost(): IRenderFrameHost & { readonly listeners: Set<Handler>; dispatch(): void } {
  const listeners = new Set<Handler>();
  return {
    listeners,
    on(_event, callback) {
      listeners.add(callback);
    },
    removeListener(_event, callback) {
      listeners.delete(callback);
    },
    dispatch() {
      listeners.forEach(listener => listener());
    },
  };
}

const focused: IFrameRateContext = { fpsLimit: 144, lastSecondFps: 60, backgroundRendering: true, documentHidden: false, windowFocused: true, windowFocusedAfter: true };

/** Visibility host that never hides, matching a normal foreground window. */
function createVisibility(hidden = false): IVisibilityHost & { hide(): void } {
  const listeners = new Set<() => void>();
  let isHidden = hidden;
  return {
    isHidden: () => isHidden,
    onVisibilityChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hide() {
      isHidden = true;
      listeners.forEach(listener => listener());
    },
  };
}

useGlobals(() => ({
  Prop: { fps: 58 },
  settings: { fps_limit: { value: 60 }, background_rendering: { value: false }, edit_size: { value: "16" } },
}));

test("sampleRenderFrames counts only frames dispatched while waiting and detaches afterwards", async () => {
  const host = createHost();
  const timeline = { now: 1000 };
  const clock = {
    now: () => timeline.now,
    wait: async (ms: number) => {
      host.dispatch();
      host.dispatch();
      host.dispatch();
      timeline.now += ms;
    },
  };
  host.dispatch();
  const sample = await sampleRenderFrames(500, host, clock);
  host.dispatch();
  expect(sample).toEqual({ frames: 3, elapsedMs: 500 });
  expect(host.listeners.size).toBe(0);
});

test("sampleRenderFrames rejects negative or non-finite windows before attaching a listener", async () => {
  const host = createHost();
  const clock = { now: () => 0, wait: async () => {} };
  await expect(sampleRenderFrames(-1, host, clock)).rejects.toThrow(RangeError);
  await expect(sampleRenderFrames(Number.NaN, host, clock)).rejects.toThrow(RangeError);
  expect(host.listeners.size).toBe(0);
});

test("sampleRenderFrames removes its listener when waiting fails", async () => {
  const host = createHost();
  const clock = { now: () => 0, wait: () => Promise.reject(new Error("timer cancelled")) };
  await expect(sampleRenderFrames(100, host, clock)).rejects.toThrow("timer cancelled");
  expect(host.listeners.size).toBe(0);
});

test("summarizeFrameRate averages over the real elapsed time, rounded to one decimal", () => {
  const summary = summarizeFrameRate({ frames: 91, elapsedMs: 1503.4 }, focused);
  expect(summary.average_fps).toBe(60.5);
  expect(summary.elapsed_ms).toBe(1503);
  expect(summary.frames).toBe(91);
  expect(summary.fps_limit).toBe(144);
  expect(summary.last_second_fps).toBe(60);
  expect(summary.focus_changed).toBe(false);
  expect(summary.rendering_paused).toBe(false);
});

test("summarizeFrameRate reports zero for an empty window instead of dividing by zero", () => {
  expect(summarizeFrameRate({ frames: 0, elapsedMs: 0 }, focused).average_fps).toBe(0);
});

test("summarizeFrameRate flags a paused loop only when unfocused without background rendering", () => {
  const paused: IFrameRateContext = { ...focused, backgroundRendering: false, windowFocused: false, windowFocusedAfter: false };
  expect(summarizeFrameRate({ frames: 0, elapsedMs: 1000 }, paused).rendering_paused).toBe(true);
  expect(summarizeFrameRate({ frames: 5, elapsedMs: 1000 }, paused).rendering_paused).toBe(false);
  expect(summarizeFrameRate({ frames: 0, elapsedMs: 1000 }, { ...paused, backgroundRendering: true }).rendering_paused).toBe(false);
  expect(summarizeFrameRate({ frames: 0, elapsedMs: 1000 }, { ...paused, windowFocused: null, windowFocusedAfter: null }).rendering_paused).toBe(false);
  expect(summarizeFrameRate({ frames: 0, elapsedMs: 1000 }, { ...paused, windowFocused: true }).rendering_paused).toBe(true);
});

test("summarizeFrameRate reports a focus change between the start and end of the window", () => {
  const changed = summarizeFrameRate({ frames: 30, elapsedMs: 1000 }, { ...focused, backgroundRendering: false, windowFocusedAfter: false });
  expect(changed.focus_changed).toBe(true);
  expect(changed.window_focused).toBe(true);
  expect(changed.rendering_paused).toBe(false);
  expect(summarizeFrameRate({ frames: 30, elapsedMs: 1000 }, { ...focused, windowFocusedAfter: null }).focus_changed).toBe(false);
});

test("readFrameRateContext narrows settings and Prop.fps, and reports focus as unknown without a document", () => {
  expect(readWindowFocus()).toBeNull();
  expect(readFrameRateContext(null)).toEqual({ fpsLimit: 60, lastSecondFps: 58, backgroundRendering: false, documentHidden: null, windowFocused: null, windowFocusedAfter: null });
  Object.assign(globalThis, { settings: { fps_limit: { value: "fast" } }, Prop: { fps: Number.NaN } });
  expect(readFrameRateContext(null)).toEqual({ fpsLimit: null, lastSecondFps: null, backgroundRendering: null, documentHidden: null, windowFocused: null, windowFocusedAfter: null });
});

test("readFrameRateContext reads focus from the document when one exists", () => {
  const restore = installGlobals({ document: { hasFocus: () => false } });
  try {
    expect(readWindowFocus()).toBe(false);
    expect(readFrameRateContext(true)).toMatchObject({ windowFocused: true, windowFocusedAfter: false });
  } finally {
    restore();
  }
});

test("sampleRenderFrames returns an empty window immediately when the page is already hidden", async () => {
  const host = createHost();
  let waited = false;
  const clock = { now: () => 0, wait: async () => { waited = true; } };
  const sample = await sampleRenderFrames(10_000, host, clock, createVisibility(true));
  expect(sample).toEqual({ frames: 0, elapsedMs: 0 });
  // A hidden page freezes its timers, so waiting would never resolve.
  expect(waited).toBe(false);
  expect(host.listeners.size).toBe(0);
});

test("sampleRenderFrames ends the window early when the page becomes hidden mid-sample", async () => {
  const host = createHost();
  const visibility = createVisibility();
  const timeline = { now: 500 };
  const clock = {
    now: () => timeline.now,
    // A frozen timer that never resolves, like a hidden page's setTimeout.
    wait: () => new Promise<void>(() => {}),
  };
  const pending = sampleRenderFrames(10_000, host, clock, visibility);
  host.dispatch();
  host.dispatch();
  timeline.now = 700;
  visibility.hide();
  expect(await pending).toEqual({ frames: 2, elapsedMs: 200 });
  expect(host.listeners.size).toBe(0);
});

test("sampleRenderFrames cancels the clock's pending wait once the window ends early", async () => {
  const host = createHost();
  const visibility = createVisibility();
  let capturedSignal: AbortSignal | undefined;
  const clock = {
    now: () => 0,
    // Mirrors the real clock's frozen timer: never settles on its own, so the
    // only way this promise moves on is the visibility branch resolving first.
    wait: (_ms: number, signal?: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<void>(() => {});
    },
  };
  const pending = sampleRenderFrames(10_000, host, clock, visibility);
  visibility.hide();
  await pending;
  // Confirms the cleanup path actually tells the clock to drop its timer,
  // rather than leaving it scheduled to fire minutes after the call returned.
  expect(capturedSignal?.aborted).toBe(true);
});

test("sampleRenderFrames unsubscribes from visibility changes once the window ends", async () => {
  const host = createHost();
  const visibility = createVisibility();
  const clock = { now: () => 0, wait: async () => {} };
  await sampleRenderFrames(100, host, clock, visibility);
  visibility.hide();
  expect(host.listeners.size).toBe(0);
});

test("summarizeFrameRate reports a hidden page as a paused loop whatever background rendering says", () => {
  const hidden: IFrameRateContext = { ...focused, documentHidden: true };
  expect(summarizeFrameRate({ frames: 0, elapsedMs: 0 }, hidden).rendering_paused).toBe(true);
  expect(summarizeFrameRate({ frames: 0, elapsedMs: 0 }, hidden).document_hidden).toBe(true);
  expect(summarizeFrameRate({ frames: 0, elapsedMs: 0 }, hidden).average_fps).toBe(0);
  // Frames counted before the page was hidden describe real rendering, not a pause.
  expect(summarizeFrameRate({ frames: 5, elapsedMs: 200 }, hidden).rendering_paused).toBe(false);
  expect(summarizeFrameRate({ frames: 0, elapsedMs: 1000 }, focused).document_hidden).toBe(false);
});

test("readDocumentHidden reports the page visibility state, or null without a document", () => {
  expect(readDocumentHidden()).toBeNull();
  const restoreHidden = installGlobals({ document: { visibilityState: "hidden" } });
  try {
    expect(readDocumentHidden()).toBe(true);
  } finally {
    restoreHidden();
  }
  const restoreVisible = installGlobals({ document: { visibilityState: "visible" } });
  try {
    expect(readDocumentHidden()).toBe(false);
  } finally {
    restoreVisible();
  }
});
