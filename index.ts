/**
 * @author jasonjgardner
 * @discord jason.gardner
 * @github https://github.com/jasonjgardner
 */
/// <reference types="three" />
/// <reference types="blockbench-types" />
import { VERSION } from "@/lib/constants";
import { createServer } from "@/server/server";
// Import tools from the tools module which re-exports from factories after registration
import { tools, prompts, getToolCount } from "@/server/tools";
import { registerToolsOnServer } from "@/lib/factories";
import { resources } from "@/server";
import { uiSetup, uiTeardown } from "@/ui";
import { settingsSetup, settingsTeardown } from "@/ui/settings";
import { sessionManager } from "@/lib/sessions";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server as NetServer, Socket } from "net";

let httpServer: NetServer | null = null;
// Map of session ID to transport and server instances
const sessionTransports = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: McpServer }>();

BBPlugin.register("mcp", {
  version: VERSION,
  title: "MCP Server",
  author: "Jason J. Gardner",
  description: "Plugin to run an MCP server inside Blockbench.",
  tags: ["MCP", "Server", "Protocol"],
  icon: "settings_ethernet",
  variant: "both",
  async onload() {
    settingsSetup();

    // Get network module with Blockbench permission handling
    // @ts-ignore - requireNativeModule is a Blockbench global
    const net = requireNativeModule("net", {
      message: "Network access is required for the MCP server to accept connections.",
      detail: "The MCP plugin needs to create a local server that AI assistants can connect to.",
      optional: false,
    });

    if (!net) {
      console.error("[MCP] Failed to get net module - server will not start");
      Blockbench.showQuickMessage("MCP Server requires network permission", 3000);
      return;
    }

    const port = Settings.get("mcp_port") || 3000;
    const endpoint = Settings.get("mcp_endpoint") || "/bb-mcp";

    console.log(`[MCP] Loaded ${getToolCount()} tools`);

    // Create TCP server to handle HTTP requests
    httpServer = net.createServer((socket: Socket) => {
      let buffer = Buffer.alloc(0);

      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        processHttpRequests().catch((err) => {
          console.error("[MCP] Unhandled error in processHttpRequests:", err);
          // Try to send error response if socket is still writable
          if (!socket.destroyed) {
            try {
              sendResponse(
                socket,
                500,
                { "content-type": "application/json" },
                JSON.stringify({ error: "Internal server error" }),
                undefined
              );
            } catch (sendErr) {
              console.error("[MCP] Failed to send error response:", sendErr);
              socket.destroy();
            }
          }
        });
      });

      socket.on("error", (err: Error) => {
        // ECONNRESET is common when clients disconnect abruptly - don't spam logs
        if (err.message !== "read ECONNRESET") {
          console.error("[MCP] Socket error:", err.message);
        }
        // Clean up the socket
        socket.destroy();
      });

      socket.on("close", () => {
        // Clean up buffer when socket closes
        buffer = Buffer.alloc(0);
      });

      async function processHttpRequests() {
        while (true) {
          // Look for end of HTTP headers
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;

          const headerSection = buffer.subarray(0, headerEnd).toString();
          const lines = headerSection.split("\r\n");
          const [method, path] = lines[0].split(" ");

          // Parse headers
          const headers: Record<string, string> = {};
          for (let i = 1; i < lines.length; i++) {
            const colonIdx = lines[i].indexOf(":");
            if (colonIdx > 0) {
              const key = lines[i].substring(0, colonIdx).trim().toLowerCase();
              const value = lines[i].substring(colonIdx + 1).trim();
              headers[key] = value;
            }
          }

          // Calculate body boundaries
          const bodyStart = headerEnd + 4;
          const contentLength = parseInt(headers["content-length"] || "0", 10);
          const requestEnd = bodyStart + contentLength;

          // Wait for complete request body
          if (buffer.length < requestEnd) return;

          const body = buffer.subarray(bodyStart, requestEnd).toString();
          buffer = buffer.subarray(requestEnd);

          // Build Web Standard Request
          const url = `http://localhost:${port}${path}`;
          const webHeaders = new Headers();
          for (const [key, value] of Object.entries(headers)) {
            webHeaders.set(key, value);
          }

          const requestInit: RequestInit = {
            method,
            headers: webHeaders,
          };

          // Add body for non-GET/HEAD requests
          if (method !== "GET" && method !== "HEAD" && body) {
            requestInit.body = body;
          }

          const webRequest = new Request(url, requestInit);

          // Check endpoint - must match exactly or have query string/trailing content
          const pathWithoutQuery = path.split("?")[0];
          if (pathWithoutQuery !== endpoint && !path.startsWith(endpoint + "/") && !path.startsWith(endpoint + "?")) {
            sendResponse(socket, 404, { "content-type": "text/plain" }, "Not Found", headers["connection"]);
            continue;
          }

          try {
            // Get or create transport for this session
            const sessionId = headers["mcp-session-id"];
            let session = sessionId ? sessionTransports.get(sessionId) : null;

            // If no session exists, create a new one with its own server and transport
            if (!session) {
              const sessionServer = createServer();
              
              // Register all tools on this session's server
              registerToolsOnServer(sessionServer);
              
              const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                enableJsonResponse: true,
                onsessioninitialized: (newSessionId: string) => {
                  console.log(`[MCP] Session initialized: ${newSessionId.slice(0, 8)}...`);
                  sessionManager.add(newSessionId);
                  // Update the map with the actual session ID
                  const sess = sessionTransports.get("__pending__");
                  if (sess) {
                    sessionTransports.delete("__pending__");
                    sessionTransports.set(newSessionId, sess);
                  }
                },
                onsessionclosed: (closedSessionId: string) => {
                  console.log(`[MCP] Session closed: ${closedSessionId.slice(0, 8)}...`);
                  sessionManager.remove(closedSessionId);
                  sessionTransports.delete(closedSessionId);
                },
              });

              // Connect this session's server to its transport
              await sessionServer.connect(transport);
              
              session = { transport, server: sessionServer };
              
              // Store with a temporary key if no session ID yet (will be updated in callback)
              if (!sessionId) {
                sessionTransports.set("__pending__", session);
              }
            }

            // Update session activity
            if (sessionId) {
              sessionManager.updateActivity(sessionId);
            }

            // Let the transport handle the MCP protocol
            const webResponse = await session.transport.handleRequest(webRequest);

            console.log(`[MCP] Response: ${webResponse.status} ${webResponse.headers.get("content-type")}`);

            // Convert Web Standard Response to HTTP
            const responseHeaders: Record<string, string> = {};
            webResponse.headers.forEach((value: string, key: string) => {
              responseHeaders[key] = value;
            });

            const contentType = webResponse.headers.get("content-type") || "";
            
            // Handle SSE streams differently from regular responses
            if (contentType.includes("text/event-stream")) {
              // Send headers for SSE
              sendSSEHeaders(socket, webResponse.status, responseHeaders);
              
              // Stream the body
              if (webResponse.body) {
                const reader = webResponse.body.getReader();
                const decoder = new TextDecoder();
                
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value, { stream: true });
                    socket.write(chunk);
                  }
                } catch (streamError) {
                  console.error("[MCP] SSE stream error:", streamError);
                } finally {
                  socket.end();
                }
              } else {
                socket.end();
              }
            } else {
              // Regular response
              const responseBody = await webResponse.text();
              sendResponse(socket, webResponse.status, responseHeaders, responseBody, headers["connection"]);
            }
          } catch (error) {
            console.error("[MCP] Request handler error:", error);
            sendResponse(socket, 500, { "content-type": "application/json" }, JSON.stringify({ error: String(error) }), headers["connection"]);
          }
        }
      }

      function sendSSEHeaders(
        sock: Socket,
        status: number,
        headers: Record<string, string>
      ) {
        let response = `HTTP/1.1 ${status} ${getStatusText(status)}\r\n`;

        // Remove content-length for SSE streams
        delete headers["content-length"];
        
        // Ensure proper SSE headers
        headers["cache-control"] = "no-cache";
        headers["connection"] = "keep-alive";

        for (const [key, value] of Object.entries(headers)) {
          response += `${key}: ${value}\r\n`;
        }
        response += "\r\n";

        sock.write(response);
      }

      function sendResponse(
        sock: Socket,
        status: number,
        headers: Record<string, string>,
        body: string,
        connection?: string
      ) {
        let response = `HTTP/1.1 ${status} ${getStatusText(status)}\r\n`;

        // Add content-length if not present
        if (!headers["content-length"]) {
          headers["content-length"] = Buffer.byteLength(body).toString();
        }

        for (const [key, value] of Object.entries(headers)) {
          response += `${key}: ${value}\r\n`;
        }
        response += "\r\n";
        response += body;

        sock.write(response);

        // Close connection unless keep-alive
        if (connection?.toLowerCase() !== "keep-alive") {
          sock.end();
        }
      }

      function getStatusText(status: number): string {
        const texts: Record<number, string> = {
          200: "OK",
          201: "Created",
          204: "No Content",
          400: "Bad Request",
          404: "Not Found",
          405: "Method Not Allowed",
          500: "Internal Server Error",
        };
        return texts[status] || "Unknown";
      }
    });

    httpServer.listen(port, () => {
      console.log(`[MCP] Server listening on http://localhost:${port}${endpoint}`);
    });

    httpServer.on("error", (err: Error) => {
      console.error("[MCP] Server error:", err);
      Blockbench.showQuickMessage(`MCP Server error: ${err.message}`, 3000);
    });

    // Create a reference server for UI display purposes
    const referenceServer = createServer();
    uiSetup({
      server: referenceServer,
      tools,
      resources,
      prompts,
    });
  },

  onunload() {
    // Close HTTP server
    if (httpServer) {
      httpServer.close();
      httpServer = null;
    }

    // Close all session transports
    for (const session of sessionTransports.values()) {
      session.transport.close();
    }
    sessionTransports.clear();

    // Clear all sessions
    sessionManager.clear();

    uiTeardown();
    settingsTeardown();
  },

  oninstall() {
    Blockbench.showQuickMessage("Installed MCP Server plugin", 2000);
    settingsSetup();
  },

  onuninstall() {
    Blockbench.showQuickMessage("Uninstalled MCP Server plugin", 2000);
    settingsTeardown();
  },
});
