/**
 * @author jasonjgardner
 * @discord jason.gardner
 * @github https://github.com/jasonjgardner
 */
/// <reference types="three" />
/// <reference types="blockbench-types" />
import { VERSION } from "@/lib/constants";
import { createServer, getServer, setServer } from "@/server/server";
import { tools, getEnabledToolDefinitions } from "@/lib/factories";
import { resources, prompts } from "@/server";
import { uiSetup, uiTeardown } from "@/ui";
import { settingsSetup, settingsTeardown } from "@/ui/settings";

// Import tools to ensure they're registered
import "@/server/tools";

let currentServer: any = null;

/**
 * Rebuilds the MCP server with only enabled tools
 */
function rebuildMCPServer() {
  const wasRunning = currentServer !== null;

  // Stop current server if running
  if (currentServer) {
    currentServer.stop();
  }

  // Create new server
  currentServer = createServer();
  setServer(currentServer);

  // Add only enabled tools
  const enabledTools = getEnabledToolDefinitions();
  Object.values(enabledTools).forEach((tool) => {
    currentServer.addTool(tool);
  });

  // Add prompts and resources
  // Note: These would need similar treatment if we implement enable/disable for them

  // Restart server if it was running
  if (wasRunning) {
    currentServer.start({
      transportType: "httpStream",
      httpStream: {
        port: Settings.get("mcp_port") || 3000,
        endpoint: Settings.get("mcp_endpoint") || "/bb-mcp",
      },
    });
  }
}

// Make the function globally accessible for the UI
(globalThis as any).rebuildMCPServer = rebuildMCPServer;

const allToolNames = Object.keys(tools).filter((tool) => tools[tool].enabled);

BBPlugin.register("mcp", {
  version: VERSION,
  title: "MCP Server",
  author: "Jason J. Gardner",
  description: "Plugin to run an MCP server inside Blockbench.",
  tags: ["MCP", "Server", "Protocol"],
  icon: "settings_ethernet",
  variant: "both",
  onload() {
    settingsSetup(allToolNames);

    currentServer = getServer();

    // Rebuild server to ensure only enabled tools are active
    rebuildMCPServer();

    uiSetup({
      server: currentServer,
      tools,
      resources,
      prompts,
    });

    currentServer.start({
      transportType: "httpStream",
      httpStream: {
        port: Settings.get("mcp_port") || 3000,
        endpoint: Settings.get("mcp_endpoint") || "/mcp",
      },
    });
  },

  onunload() {
    // Shutdown the server
    if (currentServer) {
      currentServer.stop();
      currentServer = null;
    }
    uiTeardown();
    settingsTeardown();
  },

  oninstall() {
    Blockbench.showQuickMessage("Installed MCP Server plugin", 2000);
    settingsSetup(allToolNames);
  },

  onuninstall() {
    Blockbench.showQuickMessage("Uninstalled MCP Server plugin", 2000);
    settingsTeardown();
  },
});
