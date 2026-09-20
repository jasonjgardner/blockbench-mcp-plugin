/// <reference types="blockbench-types" />

/**
 * Viewport frame-rate sampling.
 *
 * Blockbench renders every connected preview from one `requestAnimationFrame`
 * loop (`animate()` in `js/preview/preview.ts`) and dispatches `render_frame`
 * after each rendered frame. It also keeps a one-second counter in `Prop.fps`,
 * but that value is a single instantaneous reading. Counting `render_frame`
 * events over a chosen window gives a true average that also reflects frames
 * skipped by the `fps_limit` setting or by background-rendering pauses.
 *
 * @module
 */

/** Raw frame count from one sampling window. */
export interface IFrameSample {
  /** Rendered frames observed during the window. */
  readonly frames: number;
  /** Real time the window covered, in milliseconds. */
  readonly elapsedMs: number;
}

/** Host state that explains a frame sample; `null` marks a value the host does not expose. */
export interface IFrameRateContext {
  /** Blockbench's `fps_limit` setting, the ceiling the render loop enforces. */
  readonly fpsLimit: number | null;
  /** Blockbench's own last one-second frame count (`Prop.fps`). */
  readonly lastSecondFps: number | null;
  /** Blockbench's `background_rendering` setting. */
  readonly backgroundRendering: boolean | null;
  /**
   * Whether the page was hidden when sampling started, from
   * `document.visibilityState`; `null` where no document exposes it. A hidden
   * page renders no frames, because Chromium stops `requestAnimationFrame`.
   */
  readonly documentHidden: boolean | null;
  /** Whether the Blockbench window had focus when sampling started, from `document.hasFocus()`. */
  readonly windowFocused: boolean | null;
  /** Whether the window had focus when sampling ended; `null` when unknown. */
  readonly windowFocusedAfter: boolean | null;
}

/** JSON result of the `get_average_fps` tool, in snake_case for MCP clients. */
export interface IFrameRateSummary extends Record<string, unknown> {
  /** Rendered frames per second across the whole window, rounded to one decimal. */
  readonly average_fps: number;
  /** Rendered frames counted during the window. */
  readonly frames: number;
  /** Real window length in milliseconds, rounded to an integer. */
  readonly elapsed_ms: number;
  /** The `fps_limit` setting, or `null` when unavailable. */
  readonly fps_limit: number | null;
  /** Blockbench's own last one-second counter, or `null` when unavailable. */
  readonly last_second_fps: number | null;
  /** The `background_rendering` setting, or `null` when unavailable. */
  readonly background_rendering: boolean | null;
  /**
   * `true` when the Blockbench page was hidden (minimised or fully occluded),
   * or `null` outside a browser document. Chromium freezes both
   * `requestAnimationFrame` and timers for a hidden page, so no frame can
   * render and the window is reported as empty rather than waited out.
   */
  readonly document_hidden: boolean | null;
  /** Whether the window had focus when sampling started, or `null` outside a browser document. */
  readonly window_focused: boolean | null;
  /**
   * `true` when focus differed between the start and end of the window. With
   * background rendering disabled, part of the window was then not rendered, so
   * the average understates the real frame rate.
   */
  readonly focus_changed: boolean;
  /**
   * `true` when no frame rendered at all because the render loop was stopped
   * rather than slow: either the page was hidden, or the window was unfocused
   * with background rendering disabled. Blockbench skips rendering in the
   * second state (unless the pointer hovers the viewport). A window that was
   * only partly paused shows up as `focus_changed` instead.
   */
  readonly rendering_paused: boolean;
}

/** Minimal event surface of the `Blockbench` global used to observe frames. */
export interface IRenderFrameHost {
  on(eventName: "render_frame", callback: () => void): void;
  removeListener(eventName: "render_frame", callback: () => void): void;
}

/** Clock and timer used by {@link sampleRenderFrames}; overridable for deterministic tests. */
export interface ISamplingClock {
  /** Monotonic timestamp in milliseconds. */
  now(): number;
  /**
   * Resolves after `ms` milliseconds. `signal`, when given and later aborted,
   * lets the implementation drop its scheduled timer once the wait is no
   * longer needed (the window already ended some other way); it does not
   * itself settle the returned promise.
   */
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Page-visibility surface, so sampling never waits on a frozen timer;
 * overridable for deterministic tests.
 */
export interface IVisibilityHost {
  /** Whether the page is currently hidden, so no frame can render. */
  isHidden(): boolean;
  /** Subscribes to visibility changes; the returned function unsubscribes. */
  onVisibilityChange(listener: () => void): () => void;
}

const REAL_VISIBILITY: IVisibilityHost = {
  isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  onVisibilityChange: listener => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

const REAL_CLOCK: ISamplingClock = {
  now: () => performance.now(),
  wait: (ms, signal) =>
    new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
    }),
};

/**
 * Counts `render_frame` events for `durationMs` milliseconds.
 *
 * The listener is always removed, even when waiting fails, so a cancelled
 * request never leaves a counter attached to the render loop.
 *
 * Chromium freezes `requestAnimationFrame` *and* timers while a page is hidden,
 * so a hidden Blockbench window renders no frames and never fires the timer that
 * would end the window. Waiting there would hang the caller forever, so a page
 * that is already hidden returns an empty window immediately, and a page that
 * becomes hidden mid-window ends the sample at that point. Both report the
 * frames counted so far; `documentHidden` on the context explains the result.
 * Ending the window early aborts the clock's pending wait, so a real timer
 * that would otherwise still be scheduled minutes later is dropped instead of
 * firing a stray `resolve` on an already-settled promise.
 *
 * @param durationMs - Length of the sampling window; a finite, non-negative number.
 * @param host - Event emitter to observe; defaults to the `Blockbench` global.
 * @param clock - Time source; defaults to `performance.now` and `setTimeout`.
 * @param visibility - Page-visibility source; defaults to the `document` global.
 * @returns Frames rendered and the real elapsed time.
 * @throws {RangeError} When `durationMs` is negative or not finite.
 */
export async function sampleRenderFrames(
  durationMs: number,
  host: IRenderFrameHost = Blockbench,
  clock: ISamplingClock = REAL_CLOCK,
  visibility: IVisibilityHost = REAL_VISIBILITY,
): Promise<IFrameSample> {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError(`Sampling window must be a non-negative number of milliseconds, received ${durationMs}.`);
  if (visibility.isHidden()) return { frames: 0, elapsedMs: 0 };
  let frames = 0;
  const onFrame = (): void => {
    frames += 1;
  };
  host.on("render_frame", onFrame);
  const started = clock.now();
  let unsubscribe: (() => void) | undefined;
  const abortWait = new AbortController();
  try {
    await new Promise<void>((resolve, reject) => {
      unsubscribe = visibility.onVisibilityChange(() => {
        if (visibility.isHidden()) resolve();
      });
      clock.wait(durationMs, abortWait.signal).then(resolve, reject);
    });
  } finally {
    // Drops the clock's scheduled timer when the window ended some other way
    // (early via visibility, or the promise rejected); a no-op once the timer
    // has already fired, so the natural-completion path is unaffected.
    abortWait.abort();
    unsubscribe?.();
    host.removeListener("render_frame", onFrame);
  }
  return { frames, elapsedMs: clock.now() - started };
}

/**
 * Turns a raw sample and host context into the tool's JSON summary.
 *
 * @param sample - Frames and elapsed time from {@link sampleRenderFrames}.
 * @param context - Settings and focus state read alongside the sample.
 * @returns The snake_case summary returned to MCP clients.
 */
export function summarizeFrameRate(sample: IFrameSample, context: IFrameRateContext): IFrameRateSummary {
  const averageFps = sample.elapsedMs > 0 ? sample.frames / (sample.elapsedMs / 1000) : 0;
  const focusChanged = context.windowFocused !== null && context.windowFocusedAfter !== null && context.windowFocused !== context.windowFocusedAfter;
  const unfocused = context.windowFocused === false || context.windowFocusedAfter === false;
  const loopStopped = context.documentHidden === true || (unfocused && context.backgroundRendering === false);
  return {
    average_fps: Math.round(averageFps * 10) / 10,
    frames: sample.frames,
    elapsed_ms: Math.round(sample.elapsedMs),
    fps_limit: context.fpsLimit,
    last_second_fps: context.lastSecondFps,
    background_rendering: context.backgroundRendering,
    document_hidden: context.documentHidden,
    window_focused: context.windowFocused,
    focus_changed: focusChanged,
    rendering_paused: sample.frames === 0 && loopStopped,
  };
}

/**
 * Reads whether the Blockbench window has focus.
 *
 * @returns `document.hasFocus()`, or `null` where no document exists.
 */
export function readWindowFocus(): boolean | null {
  return typeof document === "undefined" ? null : document.hasFocus();
}

/**
 * Reads whether the Blockbench page is hidden, so no frame can render.
 *
 * @returns `true` when `document.visibilityState` is `hidden`, `false` when it
 * reports any other state, and `null` where no document exposes it.
 */
export function readDocumentHidden(): boolean | null {
  if (typeof document === "undefined" || typeof document.visibilityState !== "string") return null;
  return document.visibilityState === "hidden";
}

/**
 * Reads the frame-rate context from Blockbench globals after a sample,
 * tolerating hosts (tests, the docs generator) where some globals are missing.
 *
 * @param windowFocused - Focus state captured with {@link readWindowFocus} before sampling started.
 * @returns Settings, Blockbench's last-second counter, and focus at both ends of the window.
 */
export function readFrameRateContext(windowFocused: boolean | null): IFrameRateContext {
  return {
    fpsLimit: readNumberSetting("fps_limit"),
    lastSecondFps: readLastSecondFps(),
    backgroundRendering: readBooleanSetting("background_rendering"),
    documentHidden: readDocumentHidden(),
    windowFocused,
    windowFocusedAfter: readWindowFocus(),
  };
}

function readSettingValue(id: string): unknown {
  if (typeof settings === "undefined") return undefined;
  return settings[id]?.value;
}

function readNumberSetting(id: string): number | null {
  const value = readSettingValue(id);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBooleanSetting(id: string): boolean | null {
  const value = readSettingValue(id);
  return typeof value === "boolean" ? value : null;
}

function readLastSecondFps(): number | null {
  if (typeof Prop === "undefined") return null;
  const value: unknown = Prop.fps;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
