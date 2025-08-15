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

// Import tools to ensure they're registered
import "@/server/tools";

let currentServer: any = null;

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

    settingsSetup();

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
        endpoint: Settings.get("mcp_endpoint") || "/bb-mcp",
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
    settingsSetup();
  },

  onuninstall() {
    Blockbench.showQuickMessage("Uninstalled MCP Server plugin", 2000);
    settingsTeardown();
  },
});
