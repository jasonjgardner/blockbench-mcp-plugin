/**
 * Loads tool modules into a private, bundle-local registry for unit tests.
 *
 * Why a bundle: `bun test` runs every test file in one process with one module
 * cache. The real `lib/factories.ts` keeps a process-wide registry and throws on
 * duplicate tool names, and it publishes tools on the shared MCP server. Tests
 * that call `registerXTools()` directly therefore collide with other files (for
 * example `server/tools/texture.test.ts` already registers `create_texture`), and
 * `mock.module` would replace the factories for every file. Bundling the tool
 * modules with a shimmed factories module gives each test file its own copy of
 * the whole module graph without touching shared module caches.
 *
 * The bundle entry and output are written to a fresh directory under the OS temp
 * directory (never into the repository) and removed as soon as the bundle has
 * been imported — including when the build, import, or entry generation fails.
 * Everything, including `node_modules` dependencies, is bundled, so the output
 * needs no module resolution from its temp location.
 *
 * @module
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { BunPlugin, Loader } from "bun";
import { isRecord } from "./assertions";
import type { ISchemaParser } from "./shapes";

/** A tool captured from a bundle: its parameter schema and its `execute` implementation. */
export interface ITestTool {
  /** Zod schema from the bundle's own Zod copy; validate input through it before `execute`. */
  readonly parameters: ISchemaParser;
  /** The tool implementation, called with parsed parameters. */
  execute(input: unknown): unknown;
}

/** Tools captured by one {@link loadToolDefinitions} call. */
export interface IToolFixture {
  /** Captured tools keyed by tool name, in registration order. */
  readonly definitions: ReadonlyMap<string, ITestTool>;
  /** Returns a captured tool. @throws {Error} When `name` was not registered. */
  get(name: string): ITestTool;
  /** Parses `input` with the tool's schema, then executes it. See {@link callTool}. */
  call(name: string, input: unknown): Promise<unknown>;
}

/** What to bundle and how to register it. */
export interface IToolFixtureOptions {
  /** Tool modules to bundle, relative to the repository root (or absolute), e.g. `["server/tools/animation.ts"]`. */
  readonly entries: readonly string[];
  /** Exported registration functions to call, in order, e.g. `["registerAnimationTools", "registerElementTools"]`. */
  readonly register: readonly string[];
  /**
   * Module replacements keyed by repository-relative path; values are module source code.
   * `lib/factories.ts` is always replaced by the capture registry unless overridden here;
   * an override must still export `definitions` as a `Map` of captured tools.
   */
  readonly shims?: Readonly<Record<string, string>>;
  /** Parent directory for the per-load temp directory. Defaults to the OS temp directory. */
  readonly tempRoot?: string;
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const FACTORIES_MODULE = "lib/factories.ts";
const CAPTURE_FACTORIES_PATH = join(import.meta.dir, "fixtures", "capture-factories.ts");
const TEMP_PREFIX = "blockbench-mcp-tool-fixture-";
const NAMESPACE_PREFIX = "toolModule";
const LOADERS: Readonly<Record<string, Loader>> = {
  ".cjs": "js", ".cts": "ts", ".js": "js", ".jsx": "jsx", ".mjs": "js", ".mts": "ts", ".ts": "ts", ".tsx": "tsx",
};

/**
 * Bundles tool modules with a capture registry, calls their registration functions, and returns the tools.
 *
 * @example
 * let tools: IToolFixture;
 * beforeAll(async () => {
 *   tools = await loadToolDefinitions({ entries: ["server/tools/animation.ts"], register: ["registerAnimationTools"] });
 * });
 * test("creates", async () => { await tools.call("create_animation", { name: "spin", bones: {} }); });
 *
 * @param options - Entries, registration function names, optional shims, and temp root.
 * @returns The captured tools.
 * @throws {AggregateError} When the bundle fails to build; `errors` holds Bun's build logs.
 * @throws {Error} When `entries` is empty, a registration function is not exported, registration throws,
 *   or a captured tool lacks `parameters`/`execute`.
 */
export async function loadToolDefinitions(options: IToolFixtureOptions): Promise<IToolFixture> {
  if (options.entries.length === 0) throw new Error("loadToolDefinitions requires at least one entry module.");
  const exports = await withTempDirectory(options.tempRoot ?? tmpdir(), (directory) => bundleAndImport(options, directory));
  const namespaces = options.entries.map((_, index) => exports[`${NAMESPACE_PREFIX}${index}`]).filter(isRecord);
  options.register.forEach((name) => runRegistration(namespaces, name, options.entries));
  const definitions = toToolMap(exports.definitions);
  return {
    call: (name, input) => callTool(definitions, name, input),
    definitions,
    get: (name) => getTool(definitions, name),
  };
}

/**
 * Validates `input` with a captured tool's schema (as the MCP SDK would) and executes the tool.
 *
 * @param definitions - Tools returned by {@link loadToolDefinitions}.
 * @param name - Tool name.
 * @param input - Raw, unparsed tool arguments.
 * @returns Whatever the tool's `execute` resolves to.
 * @throws {Error} When the tool is missing; rejects with the schema's `ZodError` before `execute` runs on invalid input.
 */
export async function callTool(definitions: ReadonlyMap<string, ITestTool>, name: string, input: unknown): Promise<unknown> {
  const tool = getTool(definitions, name);
  return tool.execute(await tool.parameters.parseAsync(input));
}

function getTool(definitions: ReadonlyMap<string, ITestTool>, name: string): ITestTool {
  const tool = definitions.get(name);
  if (!tool) throw new Error(`Missing tool "${name}". Captured tools: ${[...definitions.keys()].join(", ") || "none"}.`);
  return tool;
}

async function withTempDirectory<T>(root: string, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(root, TEMP_PREFIX));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function bundleAndImport(options: IToolFixtureOptions, directory: string): Promise<Record<string, unknown>> {
  const entry = join(directory, "entry.ts");
  await Bun.write(entry, entrySource(options.entries));
  const shims = await resolveShims(options.shims ?? {});
  const result = await Bun.build({ entrypoints: [entry], format: "cjs", plugins: [shimPlugin(shims)], target: "bun", throw: false });
  const [output] = result.outputs;
  if (!result.success || !output) {
    const details = result.logs.map(String).join("\n");
    throw new AggregateError(result.logs, `Tool fixture bundle failed for ${options.entries.join(", ")}:\n${details}`);
  }
  const bundle = join(directory, "fixture.cjs");
  await Bun.write(bundle, output);
  const loaded: unknown = await import(bundle);
  if (!isRecord(loaded)) throw new TypeError("Tool fixture bundle did not produce a module namespace.");
  return loaded;
}

function entrySource(entries: readonly string[]): string {
  return [
    `export { definitions } from ${importSpecifier(FACTORIES_MODULE)};`,
    ...entries.map((entry, index) => `export * as ${NAMESPACE_PREFIX}${index} from ${importSpecifier(entry)};`),
  ].join("\n");
}

function importSpecifier(path: string): string {
  return JSON.stringify(toPosixPath(resolve(REPO_ROOT, path)));
}

async function resolveShims(shims: Readonly<Record<string, string>>): Promise<ReadonlyMap<string, string>> {
  const defaults = { [FACTORIES_MODULE]: await Bun.file(CAPTURE_FACTORIES_PATH).text() };
  return new Map(Object.entries({ ...defaults, ...shims }).map(([path, source]) => [resolve(REPO_ROOT, path), source]));
}

function shimPlugin(shims: ReadonlyMap<string, string>): BunPlugin {
  return {
    name: "tool-fixture-shims",
    setup(build) {
      [...shims].forEach(([shimPath, contents]) => {
        // The filter only narrows candidates by path suffix; the exact path check keeps unrelated
        // files that share the suffix (e.g. inside node_modules) untouched.
        build.onLoad({ filter: suffixFilter(shimPath) }, async ({ path }) => ({
          contents: samePath(path, shimPath) ? contents : await Bun.file(path).text(),
          loader: LOADERS[extname(path).toLowerCase()] ?? "ts",
        }));
      });
    },
  };
}

function suffixFilter(absolutePath: string): RegExp {
  const segments = relativeSegments(absolutePath).map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`[/\\\\]${segments.join("[/\\\\]")}$`);
}

function relativeSegments(absolutePath: string): string[] {
  const path = toPosixPath(absolutePath);
  const root = `${toPosixPath(REPO_ROOT)}/`;
  const relative = path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length) : path;
  return relative.split("/").filter((segment) => segment.length > 0 && !segment.endsWith(":"));
}

function samePath(left: string, right: string): boolean {
  return toPosixPath(left).toLowerCase() === toPosixPath(right).toLowerCase();
}

function toPosixPath(path: string): string {
  return resolve(path).replaceAll("\\", "/");
}

function runRegistration(namespaces: readonly Record<string, unknown>[], name: string, entries: readonly string[]): void {
  const registration = namespaces.map((namespace) => namespace[name]).find(isCallable);
  if (!registration) throw new Error(`No bundled entry exports a "${name}" function. Entries: ${entries.join(", ")}.`);
  try {
    registration();
  } catch (error) {
    throw new Error(`Registration function "${name}" failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function isCallable(value: unknown): value is () => unknown {
  return typeof value === "function";
}

function toToolMap(captured: unknown): ReadonlyMap<string, ITestTool> {
  if (!(captured instanceof Map)) throw new TypeError("The factories shim must export `definitions` as a Map of captured tools.");
  const entries: [unknown, unknown][] = [...captured.entries()];
  return new Map(entries.map(([name, tool]): [string, ITestTool] => {
    if (typeof name !== "string" || !isTestTool(tool)) {
      throw new TypeError(`Captured tool "${String(name)}" must provide parameters.parse/parseAsync and execute.`);
    }
    return [name, tool];
  }));
}

function isTestTool(value: unknown): value is ITestTool {
  return isRecord(value)
    && isRecord(value.parameters)
    && typeof value.parameters.parse === "function"
    && typeof value.parameters.parseAsync === "function"
    && typeof value.execute === "function";
}
