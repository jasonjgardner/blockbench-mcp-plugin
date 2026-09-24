/**
 * Prepares the Node-side render runtime on first use.
 *
 * The render engine (`./engine`) runs under Node because Bun cannot load Dawn's `dawn.node`, and it
 * needs three packages the rest of the headless server does not: `three`, `three-blockbench` and
 * Dawn. They are declared in `headless/package.json` and installed into a per-user cache folder the
 * first time a render is requested, so the plugin's own `node_modules` (and an `npx` install of it)
 * stay small. The engine source is then bundled with `Bun.build` into one `cli.mjs` beside them,
 * because Node refuses to strip types from files under `node_modules` (where `npx` unpacks this
 * package).
 *
 * Layout of the cache folder (`home`):
 * - `package.json`, `node_modules/`: the installed dependencies
 * - `cli.mjs`: the bundled engine
 * - `.install` / `.build`: content hashes that decide when to reinstall or rebuild
 * - `.lock/`: a directory taken while installing, so parallel agents do not corrupt each other
 *
 * @module
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Packages the bundled engine imports at run time, resolved from `home/node_modules`. */
const EXTERNAL_PACKAGES = ["three", "three/*", "three-blockbench", "@rendergl/*"];

/** File whose presence means the install finished. */
const INSTALL_PROBE = join("node_modules", "@rendergl", "headless-three-webgpu", "package.json");

/** Stale lock age in milliseconds; an install that ran this long has died. */
const LOCK_STALE_MS = 15 * 60_000;

/** Options for {@link prepareRenderRuntime}. */
export interface IPrepareOptions {
  /** Cache folder; defaults to {@link defaultRuntimeHome}. */
  home?: string;
  /** Engine source folder; defaults to the one shipped beside this file. */
  engineDir?: string;
  /** Receives progress lines (installing can take a minute the first time). */
  log?: (message: string) => void;
}

/** Per-user cache folder for the render runtime, overridable with `BB_RENDER_HOME`. */
export function defaultRuntimeHome(): string {
  const override = Bun.env.BB_RENDER_HOME;
  if (override) return resolve(override);
  const base = process.platform === "win32"
    ? Bun.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    : Bun.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "blockbench-mcp-headless", "render");
}

/** Finds the engine source folder for both the source layout (`headless/render`) and the bundled one (`dist/headless`). */
export function locateEngineDir(): string {
  const candidates = [join(import.meta.dir, "engine"), join(import.meta.dir, "..", "..", "headless", "render", "engine")];
  const found = candidates.find((candidate) => existsSync(join(candidate, "cli.ts")));
  if (found === undefined) throw new Error(`Render engine sources not found (looked in ${candidates.join(", ")}).`);
  return found;
}

/** Stable hash of file contents, used to decide when the install or bundle is out of date. */
async function hashFiles(paths: readonly string[]): Promise<string> {
  const texts = await Promise.all(paths.map(async (path) => `${path}\n${await Bun.file(path).text()}`));
  return Bun.hash(texts.join("\u0000")).toString(36);
}

/** Engine source files that feed the bundle (tests excluded). */
async function engineSources(engineDir: string): Promise<string[]> {
  const entries = await readdir(engineDir);
  return entries.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).toSorted().map((name) => join(engineDir, name));
}

const readStamp = async (path: string): Promise<string | undefined> => {
  const file = Bun.file(path);
  return (await file.exists()) ? (await file.text()).trim() : undefined;
};

/** Runs `task` while holding the cache folder's lock directory, waiting for another process to finish first. */
async function withLock<T>(home: string, task: () => Promise<T>, log: (message: string) => void): Promise<T> {
  const lock = join(home, ".lock");
  await mkdir(home, { recursive: true });
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true });
      if (Date.now() > deadline) throw new Error(`Timed out waiting for another process to prepare the render runtime (${lock}).`);
      log("Waiting for another process to finish preparing the render runtime...");
      await Bun.sleep(1000);
    }
  }
  try {
    return await task();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Installs the manifest's dependencies into `home` with npm (Node is required anyway to run the engine). */
async function installDependencies(home: string, log: (message: string) => void): Promise<void> {
  const npm = Bun.which("npm");
  if (npm === null) throw new Error("npm was not found on PATH. Install Node 23.6+ (which includes npm) to render, or run `npm install` in " + home + " yourself.");
  log(`Installing the render engine's dependencies into ${home} (first render only)...`);
  const child = Bun.spawn([npm, "install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: home, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`npm install failed in ${home} (exit ${exitCode}).\n${`${stdout}${stderr}`.trim()}`);
  if (!existsSync(join(home, INSTALL_PROBE))) throw new Error(`npm install finished but @rendergl/headless-three-webgpu is missing from ${home}.`);
}

/** Bundles the engine into `cli.mjs`, leaving the installed packages external. */
async function buildEngine(engineDir: string, home: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(engineDir, "cli.ts")],
    target: "node",
    format: "esm",
    external: EXTERNAL_PACKAGES,
  });
  const output = result.outputs[0];
  if (!result.success || output === undefined) throw new Error(`Bundling the render engine failed:\n${result.logs.map(String).join("\n")}`);
  const target = join(home, "cli.mjs");
  const temporary = `${target}.${process.pid}.tmp`;
  await Bun.write(temporary, await output.text());
  await rename(temporary, target);
}

/**
 * Makes sure the render runtime is installed and bundled, and returns the path of its `cli.mjs`.
 *
 * Work is skipped when the dependency manifest and engine sources match what was last installed
 * and bundled, so only the first render (or the first after an update) pays for it.
 *
 * @throws Error explaining what to do when npm is missing or the install fails.
 */
export async function prepareRenderRuntime(options: IPrepareOptions = {}): Promise<string> {
  const home = options.home ?? defaultRuntimeHome();
  const engineDir = options.engineDir ?? locateEngineDir();
  const log = options.log ?? (() => undefined);
  const manifest = join(dirname(dirname(engineDir)), "package.json");
  const cli = join(home, "cli.mjs");

  const installHash = await hashFiles([manifest]);
  const buildHash = await hashFiles(await engineSources(engineDir));
  const upToDate = async (): Promise<boolean> =>
    (await readStamp(join(home, ".install"))) === installHash &&
    (await readStamp(join(home, ".build"))) === buildHash &&
    existsSync(cli) &&
    existsSync(join(home, INSTALL_PROBE));
  if (await upToDate()) return cli;

  return withLock(home, async () => {
    // Another process may have finished the job while this one waited for the lock.
    if (await upToDate()) return cli;
    if ((await readStamp(join(home, ".install"))) !== installHash || !existsSync(join(home, INSTALL_PROBE))) {
      await Bun.write(join(home, "package.json"), await Bun.file(manifest).text());
      await installDependencies(home, log);
      await Bun.write(join(home, ".install"), installHash);
    }
    await buildEngine(engineDir, home);
    await Bun.write(join(home, ".build"), buildHash);
    return cli;
  }, log);
}
