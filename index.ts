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
let expressApp: any = null;
let httpServer: any = null;

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

    // Start TCP server using net module (HTTP over raw TCP)
    try {
      const net = requireNativeModule("net");
      
      if (!net) {
        throw new Error("Net module not available");
      }
      
      const port = Settings.get("mcp_port") || 3000;
      const endpoint = Settings.get("mcp_endpoint") || "/bb-mcp";

      // Create TCP server and manually handle HTTP
      httpServer = net.createServer((socket: any) => {
        let buffer = "";
        
        socket.on("data", async (chunk: Buffer) => {
          buffer += chunk.toString();
          
          // Check if we have complete HTTP request (ends with \r\n\r\n for headers)
          const headerEndIndex = buffer.indexOf("\r\n\r\n");
          if (headerEndIndex === -1) return; // Wait for more data
          
          const headerSection = buffer.substring(0, headerEndIndex);
          const bodySection = buffer.substring(headerEndIndex + 4);
          
          // Parse HTTP request line and headers
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
          
          // Only handle POST to our endpoint
          if (method !== "POST" || path !== endpoint) {
            socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            socket.end();
            return;
          }
          
          try {
            const jsonBody = JSON.parse(bodySection);
            
            // Create mock req/res objects for transport with more complete API
            const req: any = {
              method,
              url: path,
              headers,
              httpVersion: "1.1",
              httpVersionMajor: 1,
              httpVersionMinor: 1,
              complete: true,
              socket,
              on: () => {},
              once: () => {},
              emit: () => {},
              removeListener: () => {},
            };
            
            let headersSent = false;
            const res = {
              writeHead: (status: number, headers?: any) => {
                if (headersSent) return;
                headersSent = true;
                
                const statusText = status === 200 ? "OK" : status === 404 ? "Not Found" : "Internal Server Error";
                let response = `HTTP/1.1 ${status} ${statusText}\r\n`;
                
                if (headers) {
                  for (const [key, value] of Object.entries(headers)) {
                    response += `${key}: ${value}\r\n`;
                  }
                }
                response += "\r\n";
                socket.write(response);
              },
              write: (data: string) => socket.write(data),
              end: (data?: string) => {
                if (data) socket.write(data);
                socket.end();
              },
              on: () => {},
              setHeader: () => {},
              getHeader: () => undefined,
            };
            
            // Create transport for this request
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: undefined,
              enableJsonResponse: true,
            });
            
            socket.on("close", () => {
              transport.close();
            });
            
            await currentServer?.connect(transport);
            // @ts-ignore - Our mocks have enough for the transport to work
            await transport.handleRequest(req, res, jsonBody);
          } catch (error) {
            console.error("Request handling error:", error);
            socket.write("HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\n\r\n");
            socket.write(JSON.stringify({ error: "Internal server error" }));
            socket.end();
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
      Blockbench.showMessageBox({
        title: "MCP Server Error",
        message: `Failed to initialize server: ${error}`,
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
    
    currentServer = null;
    expressApp = null;
    
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
