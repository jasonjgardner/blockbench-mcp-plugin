/// <reference types="three" />
/// <reference types="blockbench-types" />
import { VERSION } from "@/lib/constants";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { withResourceErrors } from "@/lib/resourceErrors";

let serverInstance: McpServer | null = null;

/**
 * Creates a new MCP server instance using the official SDK
 */
export function createServer(): McpServer {
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
  // SDK 1.x parses resource URLs before invoking registered resource callbacks.
  // Wrap its public handler registration boundary so malformed URLs are Invalid
  // Params, while keeping SDK routing, templates, and capability handling intact.
  const setRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => setRequestHandler(schema, async (request, extra) => {
    if (request.method !== "resources/read") return handler(request, extra);
    const uri: unknown = request.params?.uri;
    try {
      if (typeof uri !== "string") throw new Error("Resource URI must be a string.");
      new URL(uri);
    } catch {
      throw new McpError(ErrorCode.InvalidParams, "Invalid resource URI.", { uri });
    }
    return withResourceErrors(() => handler(request, extra), uri);
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
