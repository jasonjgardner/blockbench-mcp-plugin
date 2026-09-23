/**
 * Renders `.bbmodel` files through bb-render, the headless three.js WebGPU
 * renderer in the blockbench-mcp-project repository (`scripts/bb-render`).
 *
 * bb-render runs on Node, not Bun: Bun segfaults inside Dawn's `dawn.node`
 * addon. So this module spawns `node <bb-render>/dist/cli.js` as a child
 * process per render. That also sidesteps Dawn's one-GPU-instance-per-process
 * rule, and a semaphore caps how many renders share the GPU at once.
 *
 * Location, in order of precedence: `--bb-render` CLI flag, the `BB_RENDER_CLI`
 * environment variable, `$BLOCKBENCH_PROJECT_ROOT/scripts/bb-render/dist/cli.js`,
 * then the sibling checkout `../blockbench-mcp-project/blockbench-mcp-project`.
 *
 * @module
 */

import { join, resolve } from "node:path";

/** Camera views bb-render understands (its `CAMERA_VIEWS`). */
export const RENDER_VIEWS = ["front", "back", "left", "right", "three-quarter", "iso", "top"] as const;

/** One camera view name. */
export type RenderView = (typeof RENDER_VIEWS)[number];

/** Built-in bb-render presets. */
export const RENDER_PRESETS = ["showcase", "turntable", "icon", "sprite-sheet-frame"] as const;

/** One preset name. */
export type RenderPreset = (typeof RENDER_PRESETS)[number];

/** How to reach bb-render. */
export interface IRendererConfig {
  /** Path to `bb-render/dist/cli.js`, or `undefined` when none was found. */
  cli: string | undefined;
  /** Node executable (bb-render needs Node 23.6+). */
  node: string;
  /** Renders allowed to run at once. */
  concurrency: number;
  /** Per-render timeout in milliseconds. */
  timeoutMs: number;
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

/**
 * Finds bb-render's CLI.
 *
 * @param explicit - Path from the `--bb-render` flag.
 * @param repoRoots - Candidate roots of this repository (source and bundled layouts differ), for the sibling-checkout default.
 */
export async function locateBbRender(explicit: string | undefined, repoRoots: readonly string[]): Promise<string | undefined> {
  const projectRoot = Bun.env.BLOCKBENCH_PROJECT_ROOT;
  const candidates = [
    explicit,
    Bun.env.BB_RENDER_CLI,
    projectRoot ? join(projectRoot, "scripts", "bb-render", "dist", "cli.js") : undefined,
    ...repoRoots.map((repoRoot) => resolve(repoRoot, "..", "blockbench-mcp-project", "blockbench-mcp-project", "scripts", "bb-render", "dist", "cli.js")),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  const checks = await Promise.all(candidates.map(async (candidate) => ({ candidate, exists: await Bun.file(candidate).exists() })));
  return checks.find((check) => check.exists)?.candidate;
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

/** Spawns bb-render processes. */
export class BbRenderer {
  private readonly semaphore: Semaphore;

  constructor(readonly config: IRendererConfig) {
    this.semaphore = new Semaphore(Math.max(1, config.concurrency));
  }

  /** Whether bb-render was found. */
  get available(): boolean {
    return this.config.cli !== undefined;
  }

  /**
   * Renders one image.
   *
   * @throws Error when bb-render is missing, times out, or exits non-zero (with its output).
   */
  async render(request: IRenderRequest): Promise<IRenderOutcome> {
    const cli = this.config.cli;
    if (!cli) {
      throw new Error(
        "bb-render was not found. Build it (cd scripts/bb-render && npm install in blockbench-mcp-project), then set BB_RENDER_CLI or pass --bb-render <path to dist/cli.js>.",
      );
    }
    return this.semaphore.run(async () => {
      const started = performance.now();
      const child = Bun.spawn([this.config.node, cli, ...buildRenderArgs(request)], { stdout: "pipe", stderr: "pipe", timeout: this.config.timeoutMs, killSignal: "SIGKILL" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const log = `${stdout}${stderr}`.trim();
      if (child.signalCode) throw new Error(`bb-render was stopped (${child.signalCode}) after ${Math.round(performance.now() - started)} ms.\n${log}`);
      if (exitCode !== 0) throw new Error(`bb-render exited with code ${exitCode}.\n${log}`);
      return { output: request.output, milliseconds: Math.round(performance.now() - started), log };
    });
  }
}
