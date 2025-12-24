/**
 * @author jasonjgardner
 * @discord jason.gardner
 * @github https://github.com/jasonjgardner
 */
/// <reference types="three" />
/// <reference types="blockbench-types" />
import { VERSION } from "@/lib/constants";
import { getServer } from "@/server/server";
import { tools } from "@/lib/factories";
import { resources, prompts } from "@/server";
import { uiSetup, uiTeardown } from "@/ui";
import { settingsSetup, settingsTeardown } from "@/ui/settings";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Import tools to ensure they're registered
import "@/server/tools";

let currentServer: McpServer | null = null;
let currentTransport: StreamableHTTPServerTransport | null = null;
let httpServer: any = null;
let isConnected = false;

/**
 * Create a ServerResponse-like wrapper for a raw socket
 */
function createResponseWrapper(socket: any) {
  let headersSent = false;
  let ended = false;
  const responseHeaders: Record<string, string> = {};
  let statusCode = 200;
  let statusMessage = "OK";

  const res: any = {
    socket,
    connection: socket,
    statusCode: 200,
    statusMessage: "OK",
    headersSent: false,
    finished: false,
    writableEnded: false,
    writableFinished: false,

    setHeader: (name: string, value: string) => {
      responseHeaders[name.toLowerCase()] = value;
    },
    getHeader: (name: string) => responseHeaders[name.toLowerCase()],
    hasHeader: (name: string) => name.toLowerCase() in responseHeaders,
    removeHeader: (name: string) => { delete responseHeaders[name.toLowerCase()]; },
    getHeaders: () => ({ ...responseHeaders }),
    getHeaderNames: () => Object.keys(responseHeaders),

    writeHead: (status: number, reasonOrHeaders?: string | Record<string, any>, headersArg?: Record<string, any>) => {
      if (headersSent || ended) {
        console.log("Response.writeHead called but already sent/ended");
        return res;
      }
      statusCode = status;
      res.statusCode = status;

      let hdrs: Record<string, any> = {};
      if (typeof reasonOrHeaders === "string") {
        statusMessage = reasonOrHeaders;
        res.statusMessage = reasonOrHeaders;
        hdrs = headersArg || {};
      } else if (reasonOrHeaders) {
        hdrs = reasonOrHeaders;
      }

      for (const [key, value] of Object.entries(hdrs)) {
        responseHeaders[key.toLowerCase()] = String(value);
      }

      headersSent = true;
      res.headersSent = true;

      const statusText = statusMessage || (status === 200 ? "OK" : status === 404 ? "Not Found" : "Error");
      let response = `HTTP/1.1 ${status} ${statusText}\r\n`;
      for (const [key, value] of Object.entries(responseHeaders)) {
        response += `${key}: ${value}\r\n`;
      }
      response += "\r\n";
      console.log("Response.writeHead:", status, JSON.stringify(responseHeaders));
      socket.write(response);
      return res;
    },

    write: (chunk: any, encodingOrCb?: string | Function, cb?: Function) => {
      if (ended) {
        console.log("Response.write called but already ended");
        return false;
      }
      if (!headersSent) {
        res.writeHead(statusCode);
      }
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      console.log("Response.write:", typeof chunk === "string" ? chunk.substring(0, 200) : "[Buffer]");
      socket.write(chunk, callback);
      return true;
    },

    end: (chunk?: any, encodingOrCb?: string | Function, cb?: Function) => {
      if (ended) {
        console.log("Response.end called but already ended");
        return res;
      }
      if (!headersSent) {
        res.writeHead(statusCode);
      }
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (chunk) {
        console.log("Response.end with chunk:", typeof chunk === "string" ? chunk.substring(0, 200) : "[Buffer]");
        socket.write(chunk);
      } else {
        console.log("Response.end (no chunk)");
      }
      socket.end();
      ended = true;
      res.finished = true;
      res.writableEnded = true;
      res.writableFinished = true;
      if (callback) callback();
      return res;
    },

    on: (event: string, cb: Function) => {
      socket.on(event, cb);
      return res;
    },
    once: (event: string, cb: Function) => {
      socket.once(event, cb);
      return res;
    },
    off: (event: string, cb: Function) => {
      socket.off(event, cb);
      return res;
    },
    emit: () => false,
    removeListener: (event: string, cb: Function) => {
      socket.removeListener(event, cb);
      return res;
    },
    addListener: (event: string, cb: Function) => {
      socket.addListener(event, cb);
      return res;
    },
    flushHeaders: () => {
      if (!headersSent) res.writeHead(statusCode);
    },
  };

  return res;
}

/**
 * Create a IncomingMessage-like wrapper for a raw socket
 */
function createRequestWrapper(socket: any, method: string, path: string, headers: Record<string, string>) {
  const req: any = {
    method,
    url: path,
    headers,
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: true,
    socket,
    connection: socket,
    on: (_event: string, _cb: Function) => req,
    once: (_event: string, _cb: Function) => req,
    off: (_event: string, _cb: Function) => req,
    emit: () => false,
    removeListener: (_event: string, _cb: Function) => req,
    addListener: (_event: string, _cb: Function) => req,
  };
  return req;
}

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

    currentServer = getServer();

    uiSetup({
      server: currentServer,
      tools,
      resources,
      prompts,
    });

    // Start HTTP server using net module
    try {
      const net = requireNativeModule("net", {
        message: "Network access is required to run the MCP server and accept connections from AI assistants.",
        optional: false,
      });

      if (!net) {
        throw new Error("Net module not available - permission may have been denied");
      }

      const port = Settings.get("mcp_port") || 3000;
      const endpoint = Settings.get("mcp_endpoint") || "/bb-mcp";

      // Create a single transport instance for the server
      // enableJsonResponse: true means responses are sent as JSON, not SSE
      currentTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
        enableJsonResponse: true,
      });

      // Connect transport to server ONCE
      await currentServer.connect(currentTransport);
      isConnected = true;
      console.log("MCP transport connected to server");

      // Create TCP server and manually handle HTTP
      httpServer = net.createServer((socket: any) => {
        let buffer = "";

        socket.on("data", async (chunk: Buffer) => {
          buffer += chunk.toString();

          // Check if we have complete HTTP request (headers end with \r\n\r\n)
          const headerEndIndex = buffer.indexOf("\r\n\r\n");
          if (headerEndIndex === -1) return;

          const headerSection = buffer.substring(0, headerEndIndex);
          const bodySection = buffer.substring(headerEndIndex + 4);

          const lines = headerSection.split("\r\n");
          const [method, path] = lines[0].split(" ");

          // Parse headers
          const headers: Record<string, string> = {};
          for (let i = 1; i < lines.length; i++) {
            const colonIndex = lines[i].indexOf(":");
            if (colonIndex > 0) {
              const key = lines[i].substring(0, colonIndex).trim().toLowerCase();
              const value = lines[i].substring(colonIndex + 1).trim();
              headers[key] = value;
            }
          }

          // Reset buffer for next request
          buffer = "";

          // Handle GET requests for server info
          if (method === "GET" && path === endpoint) {
            const info = JSON.stringify({
              name: "Blockbench MCP",
              version: VERSION,
              status: "running",
              transport: "streamable-http",
            });
            socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(info)}\r\n\r\n${info}`);
            socket.end();
            return;
          }

          // Only handle POST to our endpoint
          if (method !== "POST" || path !== endpoint) {
            socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            socket.end();
            return;
          }

          try {
            const jsonBody = JSON.parse(bodySection);
            console.log("MCP Request:", JSON.stringify(jsonBody).substring(0, 200));
            console.log("Request headers:", JSON.stringify(headers));

            // Ensure required headers for StreamableHTTPServerTransport
            // MCP Inspector may not send all required headers
            if (!headers["accept"]) {
              headers["accept"] = "application/json, text/event-stream";
            } else if (!headers["accept"].includes("text/event-stream")) {
              headers["accept"] += ", text/event-stream";
            }
            if (!headers["content-type"]) {
              headers["content-type"] = "application/json";
            }

            const req = createRequestWrapper(socket, method, path, headers);
            const res = createResponseWrapper(socket);

            // Use the shared transport to handle this request
            await currentTransport!.handleRequest(req, res, jsonBody);
            console.log("MCP Request handled");
          } catch (error) {
            console.error("Request handling error:", error);
            if (!socket.destroyed) {
              const errorJson = JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32603, message: String(error) },
                id: null
              });
              socket.write(`HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(errorJson)}\r\n\r\n${errorJson}`);
              socket.end();
            }
          }
        });

        socket.on("error", (error: Error) => {
          console.error("Socket error:", error);
        });
      });

      httpServer.listen(port, () => {
        console.log(`Blockbench MCP Server running on http://localhost:${port}${endpoint}`);
        Blockbench.showQuickMessage(`MCP Server started on port ${port}`, 2000);
      });

      httpServer.on("error", (error: Error) => {
        console.error("MCP Server error:", error);
        Blockbench.showMessageBox({
          title: "MCP Server Error",
          message: `Failed to start server: ${error.message}`,
        });
      });
    } catch (error) {
      console.error("Failed to start MCP server:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isPermissionError = errorMessage.includes("permission") || errorMessage.includes("denied");

      Blockbench.showMessageBox({
        title: "MCP Server Error",
        message: isPermissionError
          ? "Network permission is required for the MCP server to function. Please enable the permission and reload the plugin."
          : `Failed to initialize server: ${errorMessage}`,
      });
    }
  },

  onunload() {
    // Shutdown the server
    if (httpServer) {
      httpServer.close();
      httpServer = null;
    }

    if (currentTransport) {
      currentTransport.close();
      currentTransport = null;
    }

    isConnected = false;
    currentServer = null;

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
