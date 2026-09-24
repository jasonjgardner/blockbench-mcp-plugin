/**
 * @author jasonjgardner
 * @discord jason.gardner
 * @github https://github.com/jasonjgardner
 */
/// <reference types="three" />
/// <reference types="blockbench-types" />
import { VERSION } from "@/lib/constants";
import { createServer } from "@/server/server";
import { tools, prompts } from "@/server/tools";
import { resources } from "@/server";
import { uiSetup, uiTeardown } from "@/ui";
import { settingsSetup, settingsTeardown } from "@/ui/settings";
import { setupI18n } from "@/ui/i18n";
import { sessionManager } from "@/lib/sessions";
import { initPromptLoader } from "@/lib/promptLoader";
import { setupMaterialUndoRefresh, teardownMaterialUndoRefresh } from "@/lib/material-preview";
import { setupAnimationUndoRestore, teardownAnimationUndoRestore } from "@/lib/animation-undo";
import { setupEditorStateSync, teardownEditorStateSync } from "@/lib/editor-state";
import { setupAiDisclosure, teardownAiDisclosure } from "@/lib/ai-disclosure";
import { setupScratchpadMode, teardownScratchpadMode } from "@/lib/scratchpad-mode";
import { installPluginApi, uninstallPluginApi } from "@/lib/plugin-api";
import { teardownOffscreenViews } from "@/lib/views";
import type { NetServer, SessionTransports } from "@/server/net";
import createNetServer from "@/server/net";
import { getIcon } from "@/macros/getIcon" with { type: "macro" };

let httpServer: NetServer | null = null;
let sessionTransports: SessionTransports | null = null;

BBPlugin.register("mcp", {
  version: VERSION,
  title: "MCP Server",
  author: "Jason J. Gardner",
  contributors: ["jasonjgardner", "brokestar233", "nhjydywd"],
  description: "Create an MCP server inside Blockbench.",
  tags: ["MCP", "AI"],
  website: "https://jasonjgardner.github.io/blockbench-mcp-plugin/",
  repository: "https://github.com/jasonjgardner/blockbench-mcp-plugin",
  bug_tracker: "https://github.com/jasonjgardner/blockbench-mcp-plugin/issues",
  icon: getIcon(),
  variant: "desktop",
  // requireNativeModule() permission handling first shipped in Blockbench 5.0.
  min_version: "5.0.0",
  async onload() {
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

    // Initialize internationalization before any UI
    setupI18n();

    settingsSetup();
    setupAiDisclosure();
    setupScratchpadMode();
    setupMaterialUndoRefresh();
    setupAnimationUndoRestore();
    setupEditorStateSync();

    // Load prompt manifest from CDN/cache before server starts.
    // Must never abort onload — missing prompts should degrade gracefully,
    // e.g. when a new version is tagged before the CDN asset is published.
    try {
      const cdnEnabled = Settings.get("mcp_prompt_cdn_enabled") !== false;
      await initPromptLoader(cdnEnabled);
    } catch (err) {
      console.error("[MCP] Prompt loader initialization failed — continuing without prompts:", err);
    }

    // Create TCP server to handle HTTP requests
    const toFiniteNumber = (raw: unknown, fallback: number): number => {
      const n = Number(raw);
      return Number.isFinite(n) ? n : fallback;
    };
    const sessionTimeoutMin = toFiniteNumber(
      Settings.get("mcp_session_timeout"),
      30
    );
    const sseHeartbeatSec = toFiniteNumber(
      Settings.get("mcp_sse_heartbeat"),
      15
    );
    [httpServer, sessionTransports] = createNetServer(net, {
      port: Number(Settings.get("mcp_port") || 3000),
      endpoint: String(Settings.get("mcp_endpoint") || "/bb-mcp"),
      keepAlive: {
        sseHeartbeatIntervalMs: Math.max(0, sseHeartbeatSec) * 1000,
      },
      sessionConfig: {
        inactivityTimeoutMs: Math.max(1, sessionTimeoutMin) * 60 * 1000,
      },
    });

    // Built-in tools registered when @/server/tools was imported, so other
    // plugins can now add theirs; this also drains any MCP_QUEUE entries.
    installPluginApi();

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
    // First: removes plugin-contributed tools while session servers still exist to notify.
    uninstallPluginApi();
    teardownScratchpadMode();
    teardownAiDisclosure();
    teardownEditorStateSync();
    teardownMaterialUndoRefresh();
    teardownAnimationUndoRestore();
    // Close HTTP server
    if (httpServer) {
      httpServer.close();
      httpServer = null;
    }

    // Close all session transports
    const values = Array.from(sessionTransports?.values() ?? []);
    for (const session of values) {
      session.transport.close();
    }
    sessionTransports?.clear();

    // Clear all sessions
    sessionManager.clear();

    // Release plugin-owned offscreen previews only after no request can create another
    teardownOffscreenViews();

    uiTeardown();
    // Keep user-changed values (port, endpoint, ...) across plugin reloads; only uninstall drops them.
    settingsTeardown({ keepValues: true });
  },

  oninstall() {
    Blockbench.showQuickMessage("Installed MCP Server plugin", 2000);
  },

  onuninstall() {
    Blockbench.showQuickMessage("Uninstalled MCP Server plugin", 2000);
    settingsTeardown();
  },
});
