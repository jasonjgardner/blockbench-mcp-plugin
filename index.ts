/**
 * @author jasonjgardner
 * @discord jason.gardner
 * @github https://github.com/jasonjgardner
 */
/// <reference types="three" />
/// <reference types="blockbench-types" />
import { VERSION } from "./lib/constants";
import { server as mcp, tools, resources, prompts } from "./server"
import { uiSetup, uiTeardown } from "./ui";
import { settingsSetup, settingsTeardown } from "./ui/settings";

(() => {
  const onload = () => {
    settingsSetup();
    uiSetup({
      server: mcp,
      tools,
      resources,
      prompts
    });
    mcp.start({
      transportType: "httpStream",
      httpStream: {
        port: Settings.get("mcp_port") || 3000,
        endpoint: Settings.get("mcp_endpoint") || "/mcp",
      }
    });
  };

  const onunload = () => {
    // Shutdown the server
    mcp.stop();
    uiTeardown();
    settingsTeardown();
  };

  BBPlugin.register("mcp", {
    version: VERSION,
    title: "MCP Server",
    author: "Jason J. Gardner",
    description: "Adds a Model Context Protocol server to Blockbench, allowing for remote control of the editor by AI agents.",
    tags: ["AI","MCP"],
    icon: "icon.svg",
    variant: "desktop",
    await_loading: true,
    repository: "https://github.com/jasonjgardner/blockbench-mcp-server",
    min_version: "4.12.4",
    
    onload,
    onunload,
  });
})();
