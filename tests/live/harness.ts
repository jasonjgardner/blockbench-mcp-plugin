import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { desktopSuites, repositoryRoot, type DesktopSuite, type DesktopSuiteName } from "@/build/release-evidence";
import { DEFAULT_MCP_ENDPOINT, DEFAULT_MCP_PORT, VERSION } from "@/lib/constants";
import { parseJsonRecord, records } from "./narrow";

/**
 * Environment variable that overrides the MCP endpoint for live checks and
 * `release:smoke` when no endpoint is passed as the first CLI argument,
 * e.g. `BLOCKBENCH_MCP_ENDPOINT=http://localhost:3100/bb-mcp`.
 */
export const ENDPOINT_ENV_VAR = "BLOCKBENCH_MCP_ENDPOINT";

/** The plugin's default server URL (`http://localhost:3000/bb-mcp`), derived from the shared server defaults. */
export const DEFAULT_ENDPOINT = `http://localhost:${DEFAULT_MCP_PORT}${DEFAULT_MCP_ENDPOINT}`;

/**
 * `max_content_length` for `export_model`: large enough that every smoke project
 * exports inline without truncation, so exported JSON can be parsed and compared.
 */
export const MAX_EXPORT_CONTENT_LENGTH = 1_000_000;

/** Raw `callTool` response exactly as the MCP SDK returns it (content is untrusted). */
export type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

/** A tool invocation in `callTool` parameter form, used for tables of requests expected to fail. */
export interface IToolRequest {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** Options for {@link LiveSession.json}. */
export interface IJsonOptions {
  /**
   * When the tool also returns `structuredContent`, require it to equal the parsed
   * text payload and record a single `<tool> structured and text content agree` check.
   */
  readonly verifyStructured?: boolean;
}

/** Builds the result file payload from the recorded check labels; key order is preserved in the JSON file. */
export type ResultComposer = (checks: readonly string[]) => Record<string, unknown>;

/** Outcome of an operation captured without throwing, so cleanup can run before rethrowing. */
type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * Resolves the MCP endpoint: CLI argument, then {@link ENDPOINT_ENV_VAR}, then the plugin default.
 *
 * @param argument - Explicit endpoint, normally `Bun.argv[2]`; `undefined` falls through.
 * @returns Parsed endpoint URL.
 * @throws When the selected value is not a valid URL.
 */
export function resolveEndpoint(argument: string | undefined): URL {
  return new URL(argument ?? Bun.env[ENDPOINT_ENV_VAR] ?? DEFAULT_ENDPOINT);
}

/**
 * Looks up a suite from the release evidence table, the single source of result paths.
 *
 * @param name - Suite name from {@link desktopSuites}.
 * @returns The suite's `{ name, script, result }` entry.
 * @throws When the name is not in the table (only possible through a type escape).
 */
export function findDesktopSuite(name: DesktopSuiteName): DesktopSuite {
  const suite = desktopSuites.find(entry => entry.name === name);
  if (!suite) throw new Error(`Unknown desktop suite ${name}`);
  return suite;
}

/**
 * Absolute path of the JSON file `release:smoke` reads for a suite's checks.
 *
 * @param name - Suite name.
 * @returns Absolute path under `artifacts/`.
 */
export function suiteResultPath(name: DesktopSuiteName): string {
  return join(repositoryRoot, findDesktopSuite(name).result);
}

/**
 * Absolute path inside a suite's artifact directory (the directory of its result file).
 *
 * @param name - Suite name.
 * @param segments - Path segments below the suite directory, e.g. `"fixtures", "color.png"`.
 * @returns Absolute path; parent directories are created by `Bun.write`.
 */
export function suiteArtifactPath(name: DesktopSuiteName, ...segments: string[]): string {
  return join(repositoryRoot, dirname(findDesktopSuite(name).result), ...segments);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function settle<T>(operation: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

/**
 * Runs `work` and then always runs `close`, like `try/finally`, except that a close
 * failure never masks an error from `work`: it is reported on stderr and the original
 * error is rethrown. After successful work, a close failure is rethrown so the run still fails.
 *
 * @param work - Main operation.
 * @param close - Cleanup that must run whether or not `work` succeeded.
 * @returns The value produced by `work`.
 * @throws The `work` error unchanged, or a close error wrapped with its cause.
 */
export async function runThenClose<T>(work: () => Promise<T>, close: () => Promise<void>): Promise<T> {
  const outcome = await settle(work);
  const closed = await settle(close);
  if (!outcome.ok && !closed.ok) console.error(`MCP client close also failed: ${errorMessage(closed.error)}`);
  if (!outcome.ok) throw outcome.error;
  if (!closed.ok) throw new Error(`MCP client failed to close: ${errorMessage(closed.error)}`, { cause: closed.error });
  return outcome.value;
}

/**
 * Connects an MCP client, runs `work`, and always closes the client via {@link runThenClose}.
 *
 * @param clientName - MCP client name reported to the server; the version is the plugin VERSION.
 * @param endpoint - Streamable HTTP endpoint of the Blockbench plugin.
 * @param work - Operation that uses the connected client.
 * @returns The value produced by `work`.
 * @throws The connection or `work` error, or a close error wrapped with its cause.
 */
export async function withClient<T>(clientName: string, endpoint: URL, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: clientName, version: VERSION });
  return runThenClose(async () => {
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    return work(client);
  }, () => client.close());
}

/**
 * Connected live-test context: tool call helpers plus the ordered list of passed
 * check labels that becomes release evidence. Declare parameters as `session: LiveSession`
 * so TypeScript can apply the `asserts` signatures of {@link LiveSession.check}.
 */
export class LiveSession {
  /** Connected MCP client, for discovery calls such as `listTools` or `readResource`. */
  readonly client: Client;
  /** Endpoint the client is connected to; recorded in some result files. */
  readonly endpoint: URL;
  #checks: readonly string[] = [];

  /**
   * @param client - Already connected MCP client.
   * @param endpoint - Endpoint the client is connected to.
   */
  constructor(client: Client, endpoint: URL) {
    this.client = client;
    this.endpoint = endpoint;
  }

  /** Passed check labels in the order they were recorded. */
  get checks(): readonly string[] {
    return this.#checks;
  }

  /**
   * Asserts a condition, records its label as evidence, and prints a PASS line.
   *
   * @param value - Condition; any falsy value fails the run.
   * @param label - Evidence label, also used as the failure message.
   * @throws When `value` is falsy.
   */
  check(value: unknown, label: string): asserts value {
    if (!value) throw new Error(label);
    this.#record(label);
  }

  /**
   * Like {@link check}, but records the label only the first time it passes. Used by
   * helpers that verify the same invariant on every call, so evidence has no repeats.
   *
   * @param value - Condition; any falsy value fails the run, even after an earlier pass.
   * @param label - Evidence label, also used as the failure message.
   * @throws When `value` is falsy.
   */
  checkOnce(value: unknown, label: string): asserts value {
    if (!value) throw new Error(label);
    if (this.#checks.includes(label)) return;
    this.#record(label);
  }

  /**
   * Calls a tool without interpreting the result, for requests that are expected to fail.
   *
   * @param name - Tool name.
   * @param args - Tool arguments.
   * @returns The raw SDK result.
   */
  attempt(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    return this.client.callTool({ name, arguments: args });
  }

  /**
   * Calls a tool that must succeed.
   *
   * @param name - Tool name.
   * @param args - Tool arguments.
   * @returns The raw SDK result.
   * @throws When the tool reports `isError`, including its content in the message.
   */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const result = await this.attempt(name, args);
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
    return result;
  }

  /**
   * Calls a tool that must succeed and returns its first text block parsed as a JSON object.
   *
   * @param name - Tool name.
   * @param args - Tool arguments.
   * @param options - See {@link IJsonOptions}.
   * @returns Parsed JSON object.
   * @throws When the call fails, has no text block, the text is not a JSON object, or
   * structured content disagrees with it while `verifyStructured` is set.
   */
  async json(name: string, args: Record<string, unknown> = {}, options: IJsonOptions = {}): Promise<Record<string, unknown>> {
    const result = await this.call(name, args);
    const text = records(result.content, `${name} content`).find(item => item.type === "text")?.text;
    if (typeof text !== "string") throw new Error(`${name} returned no JSON text`);
    const parsed = parseJsonRecord(text, `${name} text content`);
    if (options.verifyStructured && result.structuredContent) {
      this.checkOnce(JSON.stringify(result.structuredContent) === JSON.stringify(parsed), `${name} structured and text content agree`);
    }
    return parsed;
  }

  /**
   * Exports the active project as `.bbmodel` text and requires the export to be complete.
   *
   * @param completeLabel - When given, completeness is recorded once as this evidence label.
   * @returns The complete, untruncated project JSON text.
   * @throws When the export is truncated or has no string content.
   */
  async exportProjectText(completeLabel?: string): Promise<string> {
    const result = await this.json("export_model", { codec_id: "project", max_content_length: MAX_EXPORT_CONTENT_LENGTH });
    const content = !result.truncated && typeof result.content === "string" ? result.content : undefined;
    if (completeLabel !== undefined) this.checkOnce(content !== undefined, completeLabel);
    if (content === undefined) throw new Error("Project export is truncated or has no content");
    return content;
  }

  /**
   * Exports and parses the active project.
   *
   * @param completeLabel - Optional evidence label for export completeness (recorded once).
   * @returns The parsed `.bbmodel` object.
   * @throws When the export is incomplete or not a JSON object.
   */
  async exportProject(completeLabel?: string): Promise<Record<string, unknown>> {
    return parseJsonRecord(await this.exportProjectText(completeLabel), "Exported project");
  }

  /**
   * Sends each request in order and records `<tool name> <outcome>` for each rejection.
   * Requests run sequentially so later ones observe the state left by earlier ones.
   *
   * @param requests - Invalid tool calls.
   * @param outcome - Label suffix, e.g. `"rejects unsupported or invalid request"`.
   * @throws When any request succeeds.
   */
  async expectRejected(requests: readonly IToolRequest[], outcome: string): Promise<void> {
    await Array.fromAsync(requests, async request => {
      const result = await this.client.callTool(request);
      this.check(result.isError, `${request.name} ${outcome}`);
    });
  }

  /**
   * Writes the suite's result file read by `release:smoke`.
   *
   * @param suite - Suite whose `result` path from the evidence table is written.
   * @param compose - Payload builder; defaults to `{ checks }`.
   */
  async writeResults(suite: DesktopSuiteName, compose: ResultComposer = checks => ({ checks })): Promise<void> {
    await Bun.write(suiteResultPath(suite), JSON.stringify(compose(this.checks), null, 2));
  }

  #record(label: string): void {
    this.#checks = [...this.#checks, label];
    console.log(`PASS ${label}`);
  }
}

/**
 * Entry point for a live script: connects to the resolved endpoint, runs the scenario
 * with a {@link LiveSession}, and closes the client safely.
 *
 * @param clientName - MCP client name reported to the server.
 * @param scenario - The script body.
 * @param endpoint - Defaults to {@link resolveEndpoint} applied to the first CLI argument.
 * @throws Any scenario failure, so the process exits non-zero.
 */
export async function runLiveSuite(clientName: string, scenario: (session: LiveSession) => Promise<void>, endpoint = resolveEndpoint(Bun.argv[2])): Promise<void> {
  await withClient(clientName, endpoint, client => scenario(new LiveSession(client, endpoint)));
}
