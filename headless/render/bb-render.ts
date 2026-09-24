/**
 * Renders `.bbmodel` files through the render engine in `./engine`, a port of the core of bb-render
 * (a headless three.js WebGPU renderer).
 *
 * The engine runs on Node, not Bun: Bun segfaults inside Dawn's `dawn.node` addon. So this module
 * spawns `node cli.mjs` as a child process per render. That also sidesteps Dawn's
 * one-GPU-instance-per-process rule, and a semaphore caps how many renders share the GPU at once.
 * `cli.mjs` and its packages are prepared on first use by {@link prepareRenderRuntime}.
 *
 * An explicit `cli` (the `--bb-render` flag or `BB_RENDER_CLI`) bypasses that and runs any
 * compatible external bb-render build instead.
 *
 * @module
 */

import { prepareRenderRuntime } from "./runtime";

/** Camera views bb-render understands (its `CAMERA_VIEWS`). */
export const RENDER_VIEWS = ["front", "back", "left", "right", "three-quarter", "iso", "top"] as const;

/** One camera view name. */
export type RenderView = (typeof RENDER_VIEWS)[number];

/** Built-in bb-render presets. */
export const RENDER_PRESETS = ["showcase", "turntable", "icon", "sprite-sheet-frame"] as const;

/** One preset name. */
export type RenderPreset = (typeof RENDER_PRESETS)[number];

/** How to reach the renderer. */
export interface IRendererConfig {
  /** Explicit path to a bb-render-compatible `cli.js`/`cli.mjs`; when set, nothing is installed. */
  cli?: string | undefined;
  /** Node executable (the engine needs Node 23.6+). */
  node: string;
  /** Renders allowed to run at once. */
  concurrency: number;
  /** Per-render timeout in milliseconds. */
  timeoutMs: number;
  /** Cache folder for the installed runtime; defaults to the per-user cache. */
  home?: string | undefined;
  /** Replaces {@link prepareRenderRuntime}; resolves to the CLI path. Used by tests. */
  prepare?: (() => Promise<string>) | undefined;
  /** Receives progress lines while the runtime installs. */
  log?: ((message: string) => void) | undefined;
}

/** One still-frame render request. */
export interface IRenderRequest {
  input: string;
  output: string;
  view?: RenderView;
  preset?: RenderPreset;
  width?: number;
  height?: number;
  transparent?: boolean;
  /** Animation clip name or index; renders the pose at `time`. */
  clip?: string;
  /** Clip time in seconds. */
  time?: number;
  orthographic?: boolean;
  lighting?: "studio" | "outdoor" | "flat";
}

/** Result of one render. */
export interface IRenderOutcome {
  output: string;
  milliseconds: number;
  log: string;
}

/** Limits concurrent async tasks. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  /** Runs `task` once a slot is free. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** Takes a slot, waiting for a released one (handed over directly) when all are busy. */
  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolveSlot) => this.waiting.push(resolveSlot));
  }

  /** Hands the slot to the next waiter, or frees it. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

/** Builds bb-render CLI arguments for a request. */
export function buildRenderArgs(request: IRenderRequest): string[] {
  const optional: [string, string | number | undefined][] = [
    ["--preset", request.preset],
    ["--view", request.view],
    ["--width", request.width],
    ["--height", request.height],
    ["--start", request.clip === undefined ? undefined : request.time ?? 0],
    ["--lighting", request.lighting],
  ];
  // `--clip=<value>` keeps clip names that start with "-" from being read as flags.
  const clip = request.clip === undefined ? [] : [`--clip=${request.clip}`];
  return [
    request.input,
    "-o",
    request.output,
    "--quiet",
    ...optional.flatMap(([flag, value]) => (value === undefined ? [] : [flag, String(value)])),
    ...clip,
    ...(request.transparent ? ["--transparent"] : []),
    ...(request.orthographic ? ["--ortho"] : []),
  ];
}

/** Spawns render processes. */
export class BbRenderer {
  private readonly semaphore: Semaphore;
  private cliPromise: Promise<string> | undefined;

  constructor(readonly config: IRendererConfig) {
    this.semaphore = new Semaphore(Math.max(1, config.concurrency));
  }

  /** Resolves the CLI path once: the explicit override, else the prepared runtime. A failed preparation is retried on the next render. */
  private resolveCli(): Promise<string> {
    if (this.config.cli) return Promise.resolve(this.config.cli);
    const pending = this.cliPromise ?? (this.config.prepare ?? (() => prepareRenderRuntime({ home: this.config.home, log: this.config.log })))();
    this.cliPromise = pending;
    pending.catch(() => {
      if (this.cliPromise === pending) this.cliPromise = undefined;
    });
    return pending;
  }

  /**
   * Renders one image.
   *
   * @throws Error when the runtime cannot be prepared, the render times out, or the process exits non-zero (with its output).
   */
  async render(request: IRenderRequest): Promise<IRenderOutcome> {
    const cli = await this.resolveCli().catch((error: unknown) => {
      throw new Error(`The render engine is not available: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.semaphore.run(async () => {
      const started = performance.now();
      const child = Bun.spawn([this.config.node, cli, ...buildRenderArgs(request)], { stdout: "pipe", stderr: "pipe", timeout: this.config.timeoutMs, killSignal: "SIGKILL" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const log = `${stdout}${stderr}`.trim();
      if (child.signalCode) throw new Error(`The renderer was stopped (${child.signalCode}) after ${Math.round(performance.now() - started)} ms.
${log}`);
      if (exitCode !== 0) throw new Error(`The renderer exited with code ${exitCode}.
${log}`);
      return { output: request.output, milliseconds: Math.round(performance.now() - started), log };
    });
  }
}
