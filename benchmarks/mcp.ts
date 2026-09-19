import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Deadline for one HTTP exchange and for tool/resource requests. */
const requestTimeoutMs = 60_000;
/** Deadline for session setup and tool listing, which should be fast. */
const handshakeTimeoutMs = 30_000;
/** Tools that could leave the assigned project, touch local files, or change shared host state. */
const blockedTools = new Set([
  "risky_eval",
  "trigger_action",
  "emulate_clicks",
  "fill_dialog",
  "create_project",
  "from_geo_json",
  "capture_app_screenshot",
  "create_offscreen_view",
  "delete_offscreen_view",
  "resize_offscreen_view",
]);
const blockedToolPattern =
  /(?:import|settings|plugin|close_project|select_project)/;

/** Minimal injectable client contract used by live trials and offline harness tests. */
export interface IMcp {
  tools(): Promise<Tool[]>;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  read(uri: string): Promise<unknown>;
  close(): Promise<void>;
}

/** Creates a fresh Streamable HTTP client/transport for exactly one matrix cell. */
export async function connect(
  endpoint: string,
  trialId: string,
): Promise<IMcp> {
  const client = new Client({
    name: `blockbench-benchmark-${trialId}`,
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: (input, init) => {
      const deadline = AbortSignal.timeout(requestTimeoutMs);
      return fetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, deadline])
          : deadline,
      });
    },
  });
  try {
    // SDK Transport.sessionId is declared optional while this implementation exposes
    // a string | undefined getter. The runtime contract matches; bridge that SDK type mismatch.
    await client.connect(transport as Transport, {
      timeout: handshakeTimeoutMs,
    });
  } catch (error) {
    await transport.close();
    throw error;
  }
  const collect = async (cursor?: string): Promise<Tool[]> => {
    const page = await client.listTools(cursor ? { cursor } : {}, {
      timeout: handshakeTimeoutMs,
    });
    if (!page.nextCursor) return page.tools;
    return [...page.tools, ...(await collect(page.nextCursor))];
  };
  return {
    tools: () => collect(),
    call: (name, args = {}) =>
      client.callTool({ name, arguments: args }, undefined, {
        timeout: requestTimeoutMs,
      }) as Promise<CallToolResult>,
    read: (uri) => client.readResource({ uri }, { timeout: requestTimeoutMs }),
    close: async () => {
      try {
        await transport.terminateSession();
      } finally {
        await client.close();
      }
    },
  };
}

/** Holds a machine-wide loopback lock across checkouts; the OS releases it on process exit. */
export function acquireLock(port = 47392): () => void {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    reusePort: false,
    fetch: () =>
      new Response("Blockbench benchmark in progress", { status: 423 }),
  });
  return () => void server.stop(true);
}

/** Extracts the native live project URI, which also serves as the project ownership token. */
export function projectUri(result: CallToolResult): string {
  const link = result.content.find(
    (item) =>
      item.type === "resource_link" &&
      /^blockbench:\/\/project\/.+\.bbmodel$/.test(item.uri),
  );
  if (link?.type !== "resource_link") {
    throw new Error(
      "MCP server did not return a live project file URI. Update the plugin.",
    );
  }
  return link.uri;
}

/** Baseline exclusions keep project ownership, local files and shared host settings out of model control. */
export function allowedTool(tool: Tool, reviewer = false): boolean {
  if (blockedTools.has(tool.name) || blockedToolPattern.test(tool.name))
    return false;
  if (reviewer)
    return (
      tool.annotations?.readOnlyHint === true && tool.name !== "export_model"
    );
  return true;
}
