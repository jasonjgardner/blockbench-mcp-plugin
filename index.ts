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
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server as HttpServer } from "http";

// Import tools to ensure they're registered
import "@/server/tools";

let currentServer: any = null;
let httpServer: HttpServer | null = null;

BBPlugin.register("mcp", {
  version: VERSION,
  title: "MCP Server",
  author: "Jason J. Gardner",
  description: "Plugin to run an MCP server inside Blockbench.",
  tags: ["MCP", "Server", "Protocol"],
  icon: "settings_ethernet",
  variant: "both",
  onload() {
    settingsSetup();

    currentServer = getServer();

    uiSetup({
      server: currentServer,
      tools,
      resources,
      prompts,
    });

    const app = express();
    app.use(express.json());

    const port = Settings.get("mcp_port") || 3000;
    const endpoint = Settings.get("mcp_endpoint") || "/bb-mcp";

    app.post(endpoint, async (req, res) => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        res.on("close", () => {
          transport.close();
        });

        await currentServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
    });

    httpServer = app.listen(port, () => {
      console.log(`MCP Server running on http://localhost:${port}${endpoint}`);
    });

    httpServer.on("error", (error) => {
      console.error("HTTP Server error:", error);
    });
  },

  onunload() {
    if (currentServer) {
      currentServer.close();
      currentServer = null;
    }
    if (httpServer) {
      httpServer.close();
      httpServer = null;
    }
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
