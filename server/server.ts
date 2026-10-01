/// <reference types="three" />
/// <reference types="blockbench-types" />
import { VERSION } from "@/lib/constants";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import { withResourceErrors } from "@/lib/resourceErrors";

let serverInstance: McpServer | null = null;

/** Options for {@link createServer}. */
export interface ICreateServerOptions {
  /**
   * Called when the client cancels a request and the SDK aborts its handler.
   * The SDK then sends no response; a transport that must still close the
   * request's HTTP exchange answers it here.
   */
  onRequestCancelled?: (requestId: RequestId) => void;
}

/**
 * Creates a new MCP server instance using the official SDK
 */
export function createServer(options: ICreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "Blockbench MCP",
    version: VERSION,
  }, {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
    },
    debouncedNotificationMethods: [
      "notifications/tools/list_changed",
      "notifications/resources/list_changed",
    ],
  });
  // Handlers still running. The SDK aborts a handler only on
  // notifications/cancelled, not when the connection closes; abort the rest
  // then, so tools that wait can stop.
  const running = new Set<AbortController>();
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    running.forEach((controller) => controller.abort(new Error("The MCP connection closed.")));
    running.clear();
    onclose?.();
  };
  // SDK 1.x parses resource URLs before invoking registered resource callbacks.
  // Wrap its public handler registration boundary so malformed URLs are Invalid
  // Params, while keeping SDK routing, templates, and capability handling intact.
  // Each handler also gets its own abort signal, aborted when the SDK cancels the
  // request (reported through onRequestCancelled) or when the connection closes.
  const setRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => setRequestHandler(schema, async (request, extra) => {
    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort(extra.signal.reason);
      options.onRequestCancelled?.(extra.requestId);
    };
    // A cancellation sent in the same batch as its request is processed first.
    if (extra.signal.aborted) cancel();
    else extra.signal.addEventListener("abort", cancel, { once: true });
    running.add(controller);
    const scoped = { ...extra, signal: controller.signal };
    try {
      if (request.method !== "resources/read") return await handler(request, scoped);
      const uri: unknown = request.params?.uri;
      try {
        if (typeof uri !== "string") throw new Error("Resource URI must be a string.");
        new URL(uri);
      } catch {
        throw new McpError(ErrorCode.InvalidParams, "Invalid resource URI.", { uri });
      }
      return await withResourceErrors(() => handler(request, scoped), uri);
    } finally {
      running.delete(controller);
      extra.signal.removeEventListener("abort", cancel);
    }
  });
  return server;
}

/**
 * Gets the current server instance
 */
export function getServer() {
  if (!serverInstance) {
    serverInstance = createServer();
  }
  return serverInstance;
}

/**
 * Replaces the current server instance with a new one
 * @param newServer - The new server instance
 */
export function setServer(newServer: McpServer) {
  serverInstance = newServer;
}

// Export the default server instance
const server = getServer();
export default server;
