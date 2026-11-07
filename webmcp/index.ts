/// <reference types="three" />
/// <reference types="blockbench-types" />
/// <reference types="webmcp-types" />

import { setupAiDisclosure, teardownAiDisclosure } from "@/lib/ai-disclosure";
import { setupAnimationUndoRestore, teardownAnimationUndoRestore } from "@/lib/animation-undo";
import { VERSION } from "@/lib/constants";
import { setupMaterialUndoRefresh, teardownMaterialUndoRefresh } from "@/lib/material-preview";
import { setupScratchpadMode, teardownScratchpadMode } from "@/lib/scratchpad-mode";
import { setupSketchfabTags, teardownSketchfabTags } from "@/lib/sketchfab-tags";
import { teardownOffscreenViews } from "@/lib/views";
import {
  hasWebMcpSupport,
  registerWebMcpToolset,
  type IWebMcpRegistrationHandle,
  type IWebMcpToolDefinition,
} from "@/webmcp/runtime";
import { createBlockbenchWebMcpTools } from "@/webmcp/tools";

export * from "@/webmcp/runtime";
export * from "@/webmcp/tools";
export * from "@/webmcp/adapter";

/** Blockbench events that can alter tool availability conditions (`{ project: true }`, mode switches). */
const WEBMCP_SYNC_EVENTS = [
  "select_project",
  "unselect_project",
  "close_project",
  "new_project",
  "load_project",
  "select_mode",
  "unselect_mode",
] as const;

interface IHostEventBus {
  on(event: string, cb: () => void): unknown;
  removeListener(event: string, cb: () => void): unknown;
}

let activeHandle: IWebMcpRegistrationHandle | null = null;
let syncListener: (() => void) | null = null;
/** Contributed tools keyed by name; a re-registration under the same name replaces the earlier one. */
let extraTools: ReadonlyMap<string, IWebMcpToolDefinition> = new Map();

/**
 * Registers an additional WebMCP tool contributed by another plugin or caller
 * and refreshes `document.modelContext` registrations if the plugin is loaded.
 *
 * @param tool - WebMCP tool definition to add.
 */
export async function registerAdditionalWebMcpTool(tool: IWebMcpToolDefinition): Promise<void> {
  extraTools = new Map([...extraTools, [tool.name, tool]]);
  if (activeHandle) {
    await restartWebMcpRegistration();
  }
}

/**
 * Rebuilds the active `registerWebMcpToolset` handle with core + contributed tools.
 */
async function restartWebMcpRegistration(): Promise<void> {
  if (activeHandle) {
    activeHandle.dispose();
    activeHandle = null;
  }
  const allTools = [...createBlockbenchWebMcpTools(), ...extraTools.values()];
  activeHandle = await registerWebMcpToolset(allTools);
}

/**
 * Starts the Blockbench WebMCP lifecycle: sets up shared `@/lib` undo/material/animation/AI
 * hooks, registers the WebMCP tools on `document.modelContext`, and binds editor events.
 */
export async function setupWebMcpPlugin(): Promise<IWebMcpRegistrationHandle | null> {
  setupAiDisclosure();
  setupSketchfabTags();
  setupScratchpadMode();
  setupMaterialUndoRefresh();
  setupAnimationUndoRestore();

  if (!hasWebMcpSupport()) {
    if (typeof Blockbench !== "undefined" && typeof Blockbench.showQuickMessage === "function") {
      Blockbench.showQuickMessage(
        "WebMCP is not enabled in this browser (enable chrome://flags/#enable-webmcp-testing).",
        4000,
      );
    }
    return null;
  }

  await restartWebMcpRegistration();

  if (typeof Blockbench !== "undefined" && "on" in Blockbench) {
    const bus = Blockbench as unknown as IHostEventBus;
    const onStateChange = (): void => {
      void activeHandle?.refreshAvailability();
    };
    syncListener = onStateChange;
    WEBMCP_SYNC_EVENTS.forEach(event => bus.on(event, onStateChange));
  }

  return activeHandle;
}

/**
 * Tears down all registered WebMCP tools (`AbortController.abort()`), removes
 * Blockbench event listeners, and cleans up `@/lib` hooks.
 */
export function teardownWebMcpPlugin(): void {
  if (syncListener && typeof Blockbench !== "undefined" && "removeListener" in Blockbench) {
    const bus = Blockbench as unknown as IHostEventBus;
    const listener = syncListener;
    WEBMCP_SYNC_EVENTS.forEach(event => bus.removeListener(event, listener));
  }
  syncListener = null;

  if (activeHandle) {
    activeHandle.dispose();
    activeHandle = null;
  }

  teardownScratchpadMode();
  teardownAiDisclosure();
  teardownSketchfabTags();
  teardownMaterialUndoRefresh();
  teardownAnimationUndoRestore();
  teardownOffscreenViews();
}

// Register the Blockbench web-variant plugin when running inside Blockbench (`BBPlugin` global present).
if (typeof BBPlugin !== "undefined" && typeof BBPlugin.register === "function") {
  BBPlugin.register("mcp_web", {
    version: VERSION,
    title: "Blockbench WebMCP",
    author: "Jason J. Gardner",
    description: "Exposes Blockbench modeling, texturing, UV, animation, and export tools to in-browser AI agents via W3C WebMCP (document.modelContext).",
    tags: ["MCP", "WebMCP", "AI"],
    website: "https://jasonjgardner.github.io/blockbench-mcp-plugin/",
    repository: "https://github.com/jasonjgardner/blockbench-mcp-plugin",
    bug_tracker: "https://github.com/jasonjgardner/blockbench-mcp-plugin/issues",
    icon: "robot",
    variant: "web",
    min_version: "5.0.0",
    onload() {
      void setupWebMcpPlugin();
    },
    onunload() {
      teardownWebMcpPlugin();
    },
    oninstall() {
      if (typeof Blockbench !== "undefined" && typeof Blockbench.showQuickMessage === "function") {
        Blockbench.showQuickMessage("Installed Blockbench WebMCP plugin", 2000);
      }
    },
    onuninstall() {
      teardownWebMcpPlugin();
      if (typeof Blockbench !== "undefined" && typeof Blockbench.showQuickMessage === "function") {
        Blockbench.showQuickMessage("Uninstalled Blockbench WebMCP plugin", 2000);
      }
    },
  });
}
