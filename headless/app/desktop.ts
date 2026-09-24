/**
 * Finds and starts the Blockbench desktop app, optionally with a file to open.
 *
 * Blockbench's Electron main process holds a single-instance lock
 * (electron/main.js): starting it again while it runs forwards the LAST argument
 * to the open window as `open-model` and focuses it, and a first start opens
 * `process.argv.last()` (js/desktop.ts). So `Blockbench <file>` both launches the
 * app and opens a file in an already-running one. On macOS the app is started
 * with `open -a`, which delivers files through the `open-file` event.
 *
 * The app is spawned detached, without a shell, and with `ELECTRON_RUN_AS_NODE`
 * removed from its environment: Electron-based MCP hosts set that variable, and
 * it would make Blockbench run as plain Node and exit.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** URL of the desktop plugin's MCP endpoint (Settings > General in Blockbench). */
export const DEFAULT_DESKTOP_MCP_URL = "http://localhost:3000/bb-mcp";
/** How long a launch watches for the app exiting with an error. */
const EARLY_EXIT_MS = 1500;

/** Options for talking to the desktop app. */
export interface IDesktopOptions {
  /** Blockbench executable (or .app bundle on macOS) from `--blockbench`; located automatically when unset. */
  executable?: string;
  /** Desktop plugin MCP endpoint, polled by `wait_for_mcp_ms`. */
  mcpUrl: string;
}

/** Command that starts Blockbench. */
export interface ILaunchCommand {
  command: string;
  args: string[];
}

/** Outcome of a launch. */
export interface ILaunchResult extends ILaunchCommand {
  pid: number | undefined;
}

/** Environment fields the locator reads. */
type Env = Readonly<Record<string, string | undefined>>;

/**
 * Standard install locations, most likely first.
 *
 * Windows: the per-user NSIS installer (`%LOCALAPPDATA%\Programs\Blockbench`) and machine-wide installs.
 * macOS: the .app bundle. Linux: distro packages, snap, flatpak exports and an AppImage in ~/Applications.
 */
export function candidatePaths(platform: NodeJS.Platform, env: Env): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const byPlatform: Partial<Record<NodeJS.Platform, string[]>> = {
    win32: [
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Blockbench", "Blockbench.exe"),
      env.ProgramFiles && join(env.ProgramFiles, "Blockbench", "Blockbench.exe"),
      env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Blockbench", "Blockbench.exe"),
    ].filter((path): path is string => Boolean(path)),
    darwin: ["/Applications/Blockbench.app", join(home, "Applications", "Blockbench.app")],
    linux: [
      "/usr/bin/blockbench",
      "/usr/local/bin/blockbench",
      "/opt/Blockbench/blockbench",
      "/snap/bin/blockbench",
      "/var/lib/flatpak/exports/bin/net.blockbench.Blockbench",
      join(home, ".local", "share", "flatpak", "exports", "bin", "net.blockbench.Blockbench"),
      join(home, "Applications", "Blockbench.AppImage"),
    ],
  };
  return byPlatform[platform] ?? byPlatform.linux ?? [];
}

/**
 * Locates Blockbench: the explicit path, then `$BLOCKBENCH_PATH`, then `blockbench` on PATH, then standard locations.
 *
 * @returns The first existing candidate, or undefined.
 * @throws Error when an explicit path is given but missing, rather than silently launching some other install.
 */
export function locateBlockbench(
  explicit: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
  exists: (path: string) => boolean = existsSync,
  which: (name: string) => string | null = (name) => Bun.which(name),
): string | undefined {
  if (explicit !== undefined && !exists(explicit)) throw new Error(`--blockbench points to ${explicit}, which does not exist.`);
  const onPath = which("blockbench") ?? undefined;
  const candidates = [explicit, env.BLOCKBENCH_PATH, onPath, ...candidatePaths(platform, env)].filter((path): path is string => Boolean(path));
  return candidates.find((path) => exists(path));
}

/** The command line for starting Blockbench, with `file` as the last argument so a running instance opens it. */
export function launchCommand(executable: string, file: string | undefined, platform: NodeJS.Platform = process.platform): ILaunchCommand {
  const files = file ? [file] : [];
  const trimmed = executable.replace(/[\\/]+$/, "");
  if (platform === "darwin" && trimmed.toLowerCase().endsWith(".app")) return { command: "open", args: ["-a", trimmed, ...files] };
  return { command: trimmed, args: files };
}

/** The server's environment without variables that would stop Electron from starting as an app. */
export function launchEnv(env: Env = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined));
}

/**
 * Starts Blockbench detached from this process and watches it briefly: a
 * second instance hands its file to the running app and exits with 0, but an
 * exit with an error code (a broken install, no display) is reported.
 *
 * @throws Error when the executable cannot be started or exits with an error right away.
 */
export function launchBlockbench(executable: string, file: string | undefined, platform: NodeJS.Platform = process.platform): Promise<ILaunchResult> {
  const { command, args } = launchCommand(executable, file, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false, env: launchEnv() });
    child.once("error", (error) => reject(new Error(`Could not start Blockbench (${command}): ${error.message}`)));
    child.once("spawn", () => {
      const settle = setTimeout(() => {
        child.removeAllListeners("exit");
        child.unref();
        resolve({ command, args, pid: child.pid });
      }, EARLY_EXIT_MS);
      child.once("exit", (code, signal) => {
        clearTimeout(settle);
        if (code === 0) return resolve({ command, args, pid: child.pid });
        reject(new Error(`Blockbench exited right after starting (${signal ?? `code ${code}`}). On Linux, check that a display is available and that a snap or flatpak build may read the workspace folder.`));
      });
    });
  });
}

/**
 * Polls the desktop plugin's MCP endpoint until it answers. A bare GET gets a
 * JSON-RPC error body from the plugin ("Mcp-Session-Id header is required"),
 * which proves it is the MCP server without opening a session; any other
 * server on the port does not count.
 *
 * @returns Whether it answered, and after how long.
 */
export async function waitForEndpoint(url: string, timeoutMs: number, intervalMs = 500): Promise<{ reachable: boolean; waited_ms: number }> {
  const started = Date.now();
  const probe = async (): Promise<boolean> => {
    try {
      const response = await fetch(url, { method: "GET", headers: { accept: "application/json, text/event-stream" }, signal: AbortSignal.timeout(Math.min(2000, Math.max(250, timeoutMs))) });
      const body: unknown = await response.json();
      return typeof body === "object" && body !== null && (body as { jsonrpc?: unknown }).jsonrpc === "2.0";
    } catch {
      return false;
    }
  };
  const poll = async (): Promise<boolean> => {
    if (await probe()) return true;
    if (Date.now() - started + intervalMs > timeoutMs) return false;
    await Bun.sleep(intervalMs);
    return poll();
  };
  const reachable = await poll();
  return { reachable, waited_ms: Date.now() - started };
}
