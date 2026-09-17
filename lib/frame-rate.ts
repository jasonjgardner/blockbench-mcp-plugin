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
  /** Whether the window had focus when sampling started, or `null` outside a browser document. */
  readonly window_focused: boolean | null;
  /**
   * `true` when focus differed between the start and end of the window. With
   * background rendering disabled, part of the window was then not rendered, so
   * the average understates the real frame rate.
   */
  readonly focus_changed: boolean;
  /**
   * `true` when no frame rendered at all while the window was unfocused with
   * background rendering disabled. Blockbench skips rendering in that state
   * (unless the pointer hovers the viewport), so the average describes a paused
   * loop rather than slow rendering. A window that was only partly paused shows
   * up as `focus_changed` instead.
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
  /** Resolves after `ms` milliseconds. */
  wait(ms: number): Promise<void>;
}

const REAL_CLOCK: ISamplingClock = {
  now: () => performance.now(),
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/**
 * Counts `render_frame` events for `durationMs` milliseconds.
 *
 * The listener is always removed, even when waiting fails, so a cancelled
 * request never leaves a counter attached to the render loop.
 *
 * @param durationMs - Length of the sampling window; a finite, non-negative number.
 * @param host - Event emitter to observe; defaults to the `Blockbench` global.
 * @param clock - Time source; defaults to `performance.now` and `setTimeout`.
 * @returns Frames rendered and the real elapsed time.
 * @throws {RangeError} When `durationMs` is negative or not finite.
 */
export async function sampleRenderFrames(
  durationMs: number,
  host: IRenderFrameHost = Blockbench,
  clock: ISamplingClock = REAL_CLOCK,
): Promise<IFrameSample> {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError(`Sampling window must be a non-negative number of milliseconds, received ${durationMs}.`);
  let frames = 0;
  const onFrame = (): void => {
    frames += 1;
  };
  host.on("render_frame", onFrame);
  const started = clock.now();
  try {
    await clock.wait(durationMs);
  } finally {
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
  return {
    average_fps: Math.round(averageFps * 10) / 10,
    frames: sample.frames,
    elapsed_ms: Math.round(sample.elapsedMs),
    fps_limit: context.fpsLimit,
    last_second_fps: context.lastSecondFps,
    background_rendering: context.backgroundRendering,
    window_focused: context.windowFocused,
    focus_changed: focusChanged,
    rendering_paused: sample.frames === 0 && unfocused && context.backgroundRendering === false,
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
