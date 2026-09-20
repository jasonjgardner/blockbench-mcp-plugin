import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ReadResourceResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { asMcpFailure, McpFailure } from "./agent";
import { sequential } from "./config";
import type { IContext } from "./context";
import { type Evidence, errorText } from "./evidence";
import { allowedTool, type IMcp, projectUri } from "./mcp";
import { assertSafeCall, textOnlyResult, textResult } from "./policy";

/** Extra tool the proxy serves itself, so CLI agents can read the snapshotted guidance. */
export const guidanceTool = "read_guidance";

const resourceSchema = z.object({
  contents: z.array(
    z.object({ uri: z.string(), text: z.string() }).passthrough(),
  ),
});

/** What one trial's proxy forwards to and enforces. */
export interface IProxyOptions {
  upstream: IMcp;
  evidence: Evidence;
  context: IContext;
  /** Live project URI the agent may work on; checked before and after every call. */
  project: string;
  /** Offscreen view reserved for evidence; camera tools must target it. */
  view: string;
  /** Text returned to the agent per result; the full result is archived. */
  observationCharacters: number;
}

/**
 * Loopback MCP server that CLI agents (claude, codex, gemini) connect to instead of
 * Blockbench. It lists only policy-allowed tools, forwards calls one at a time,
 * archives every request and result, returns text-only observations, enforces a
 * per-stage tool-call budget, and stops everything if the project changes or the
 * Blockbench connection fails.
 */
export class PolicyProxy {
  toolCalls = 0;
  toolErrors = 0;
  /** Set when the agent asked for a tool after its stage budget ran out. */
  stageExhausted = false;
  /** Unrecoverable Blockbench failure; the trial must stop and report it. */
  fatal: McpFailure | undefined;
  private stageCalls = 0;
  private stageLimit = Number.POSITIVE_INFINITY;
  private listedNames = "";
  private readonly fatalController = new AbortController();
  private readonly sessions = new Map<
    string,
    WebStandardStreamableHTTPServerTransport
  >();
  private readonly servers: Server[] = [];
  private http: ReturnType<typeof Bun.serve> | undefined;

  constructor(private readonly options: IProxyOptions) {}

  /** Starts listening on an OS-assigned loopback port. */
  static async start(options: IProxyOptions): Promise<PolicyProxy> {
    const proxy = new PolicyProxy(options);
    proxy.http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request) => proxy.handle(request),
    });
    return proxy;
  }

  /** Streamable HTTP endpoint for the CLI's MCP configuration. */
  get url(): string {
    if (!this.http) throw new Error("Proxy is not running.");
    return `http://127.0.0.1:${this.http.port}/mcp`;
  }

  /** Aborts when a fatal failure occurs, so the running CLI can be stopped at once. */
  get fatalSignal(): AbortSignal {
    return this.fatalController.signal;
  }

  /** Resets the per-stage tool-call budget. */
  beginStage(toolCallLimit: number): void {
    this.stageCalls = 0;
    this.stageLimit = toolCallLimit;
    this.stageExhausted = false;
  }

  /** Closes every agent session and stops listening. */
  async close(): Promise<void> {
    await sequential(this.servers, (server) => server.close());
    await this.http?.stop(true);
  }

  /** Allowed upstream tools plus the guidance reader, as the agent should see them. */
  async listTools(): Promise<Tool[]> {
    const { upstream, context } = this.options;
    const tools = await this.upstream(() => upstream.tools());
    this.listedNames = names(tools);
    const guidance: Tool = {
      name: guidanceTool,
      description: `Reads a Blockbench guidance file (skill or reference) snapshotted for this benchmark. Available paths: ${JSON.stringify(Object.keys(context.files))}`,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      annotations: { readOnlyHint: true },
    };
    return [...tools.filter((tool) => allowedTool(tool)), guidance];
  }

  /** Runs one agent tool call under the benchmark policy; failures become error results. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { evidence } = this.options;
    await evidence.event("agent-tool-request", { name, arguments: args });
    try {
      return await this.dispatch(name, args);
    } catch (error) {
      if (error instanceof McpFailure) this.setFatal(error);
      await evidence.event("action-error", { name, error: errorText(error) });
      return textResult(errorText(error), true);
    }
  }

  /** The assigned project file as a resource; no other resource is reachable. */
  async readResource(uri: string): Promise<ReadResourceResult> {
    const { upstream, project, evidence, observationCharacters } = this.options;
    if (uri !== project) {
      throw new Error("Only the assigned project resource is available.");
    }
    await this.assertProject();
    const raw = await this.upstream(() => upstream.read(uri));
    const text =
      resourceSchema.parse(raw).contents.find((item) => item.uri === uri)
        ?.text ?? "";
    await evidence.event("resource-result", { uri, characters: text.length });
    const clipped =
      text.length <= observationCharacters
        ? text
        : `${text.slice(0, observationCharacters)}\n[TRUNCATED; use targeted tools such as get_project_info or list_outline.]`;
    return {
      contents: [{ uri, mimeType: "application/json", text: clipped }],
    };
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { upstream, evidence, context, view, observationCharacters } =
      this.options;
    if (this.fatal) throw this.fatal;
    if (name === guidanceTool) {
      const path = typeof args.path === "string" ? args.path : "";
      if (!Object.hasOwn(context.files, path)) {
        throw new Error(
          "Unknown guidance path; use a path listed in the tool description.",
        );
      }
      return textResult(context.files[path] ?? "");
    }
    if (this.stageCalls >= this.stageLimit) {
      this.stageExhausted = true;
      throw new Error(
        "Tool-call budget for this stage is used up. Do not call more tools; give your final stage summary now.",
      );
    }
    const tools = await this.upstream(() => upstream.tools());
    const tool = tools.find((item) => item.name === name);
    if (!tool) {
      throw new Error(
        "Tool is not currently available. Blockbench hides tools whose project, mode, format or selection requirements are unmet; switch mode first or use a listed tool.",
      );
    }
    if (!allowedTool(tool)) {
      throw new Error("Tool is not available under this track's policy.");
    }
    assertSafeCall(name, args, view);
    await this.assertProject();
    this.stageCalls += 1;
    this.toolCalls += 1;
    const archived = await this.upstream(async () => {
      const response = await upstream.call(name, args);
      if (response.isError) this.toolErrors += 1;
      return evidence.materialize(response);
    });
    await evidence.event("tool-result", { name, result: archived });
    await this.assertProject();
    await this.announceToolChanges();
    return textOnlyResult(archived, observationCharacters);
  }

  /** Tells connected agents to re-list tools when Blockbench enabled or disabled some. */
  private async announceToolChanges(): Promise<void> {
    const current = names(
      await this.upstream(() => this.options.upstream.tools()),
    );
    if (current === this.listedNames) return;
    this.listedNames = current;
    await sequential(this.servers, (server) =>
      server.sendToolListChanged().catch(() => undefined),
    );
  }

  private async assertProject(): Promise<void> {
    const { upstream, project } = this.options;
    const result = await this.upstream(() => upstream.call("get_project_info"));
    if (result.isError || projectUri(result) !== project) {
      throw new McpFailure(
        "Active project changed; benchmark stopped to prevent contamination.",
      );
    }
  }

  /** Runs Blockbench work; any transport failure becomes a fatal McpFailure. */
  private async upstream<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await asMcpFailure(work);
    } catch (error) {
      if (error instanceof McpFailure) this.setFatal(error);
      throw error;
    }
  }

  private setFatal(error: McpFailure): void {
    this.fatal ??= error;
    if (!this.fatalController.signal.aborted) {
      this.fatalController.abort(this.fatal);
    }
  }

  private createServer(): Server {
    const server = new Server(
      { name: "blockbench-benchmark-proxy", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true }, resources: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await this.listTools(),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.callTool(request.params.name, request.params.arguments ?? {}),
    );
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: this.options.project,
          name: "Assigned benchmark project",
          mimeType: "application/json",
        },
      ],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
      this.readResource(request.params.uri),
    );
    return server;
  }

  /** Routes HTTP requests to per-session transports, creating one per initialize. */
  private async handle(request: Request): Promise<Response> {
    const session = request.headers.get("mcp-session-id");
    const existing = session ? this.sessions.get(session) : undefined;
    if (existing) return existing.handleRequest(request);
    if (session || request.method !== "POST") {
      return new Response("Unknown session", { status: 404 });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, transport);
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });
    const server = this.createServer();
    this.servers.push(server);
    // SDK Transport.sessionId typing differs from this implementation's getter; runtime matches.
    await server.connect(transport as Transport);
    return transport.handleRequest(request);
  }
}

/** Stable fingerprint of a tool list, for detecting availability changes. */
function names(tools: readonly Tool[]): string {
  return tools
    .map((tool) => tool.name)
    .toSorted()
    .join(",");
}
