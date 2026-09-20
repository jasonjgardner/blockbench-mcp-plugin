import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IMCPTool, IMCPPrompt, IMCPResource } from "@/types";
import { VERSION } from "@/lib/constants";
import { AI_USAGE_CHANGED } from "@/lib/ai-disclosure";
import { statusBarSetup, statusBarTeardown } from "@/ui/statusBar";
import { sessionManager, type ISession } from "@/lib/sessions";
import { openToolTestDialog } from "@/ui/toolTestDialog";
import { openPromptPreviewDialog } from "@/ui/promptPreviewDialog";
import { openPromptOverrideDialog, overrideDialogTeardown, PROMPT_OVERRIDE_CHANGED } from "@/ui/promptOverrideDialog";
import { isShowExperimentalEnabled, panelToolbarSetup, panelToolbarTeardown, refreshPanelToolbar } from "@/ui/panelToolbar";
import { hasPromptOverride } from "@/lib/promptLoader";
import { formatArgumentCount } from "@/ui/i18n";
import panelCSS from "@/ui/panel.css";
import template from "@/ui/panel.html";

/** Tab switches change the active project; the host refreshes every toolbar after other project events itself. */
const PROJECT_EVENTS = ["select_project"] as const;

// blockbench-types 5.0 omits several host events, so the dispatcher is narrowed here.
interface IHostEvents {
  on(event: string, callback: () => void): unknown;
  removeListener(event: string, callback: () => void): unknown;
}

interface ISectionFilter {
  search: string;
}

interface IPanelState {
  showExperimental: boolean;
}

let panel: Panel | undefined;
let unsubscribe: (() => void) | undefined;
let overrideListener: (() => void) | undefined;
let badgeListener: (() => void) | undefined;
let panelStyles: Deletable | undefined;

/** The host search bar takes no label props; copy the section label onto its input after mount. */
function labelSearchInputs(root: Element): void {
  root.querySelectorAll<HTMLElement>(".mcp-search").forEach(bar => {
    const label = bar.dataset.label;
    const input = bar.querySelector("input");
    if (!label || !input) return;
    input.placeholder = label;
    input.setAttribute("aria-label", label);
  });
}

/** Pushes the toolbar toggle value into the mounted panel's Vue state. */
function setShowExperimental(value: boolean): void {
  const state = panel?.vue as unknown as IPanelState | undefined;
  if (state) state.showExperimental = value;
}

export function uiSetup({
  server,
  tools,
  resources,
  prompts,
}: {
  server: McpServer;
  tools: Record<string, IMCPTool>;
  resources: Record<string, IMCPResource>;
  prompts: Record<string, IMCPPrompt>;
}) {
  panelStyles = Blockbench.addCSS(panelCSS);

  // Setup the status bar
  statusBarSetup(server);

  const toolbar = panelToolbarSetup(setShowExperimental);

  panel = new Panel("mcp_panel", {
    id: "mcp_panel",
    icon: "robot",
    name: "MCP",
    growable: true,
    resizable: true,
    expand_button: true,
    default_side: "right",
    default_position: {
      slot: "right_bar",
      float_position: [0, 0],
      float_size: [360, 480],
      height: 400,
      folded: false,
    },
    toolbars: [toolbar],
    component: {
      mounted() {
        // Subscribe to session changes
        // @ts-ignore
        const vm = this;
        unsubscribe = sessionManager.subscribe((sessions: ISession[]) => {
          vm.sessions = sessions.map((s: ISession) => ({
            id: s.id,
            connectedAt: s.connectedAt,
            lastActivity: s.lastActivity,
            clientName: s.clientName,
            clientVersion: s.clientVersion,
          }));
          vm.server.connected = sessions.length > 0;
        });

        // Listen for override changes to refresh badge state
        const handler = () => vm.$forceUpdate();
        document.addEventListener(PROMPT_OVERRIDE_CHANGED, handler);
        overrideListener = () => document.removeEventListener(PROMPT_OVERRIDE_CHANGED, handler);

        // The AI badge is a native bar item; re-evaluate its condition when the project or stamp changes.
        const events = Blockbench as unknown as IHostEvents;
        document.addEventListener(AI_USAGE_CHANGED, refreshPanelToolbar);
        PROJECT_EVENTS.forEach(event => events.on(event, refreshPanelToolbar));
        badgeListener = () => {
          document.removeEventListener(AI_USAGE_CHANGED, refreshPanelToolbar);
          PROJECT_EVENTS.forEach(event => events.removeListener(event, refreshPanelToolbar));
        };
        refreshPanelToolbar();
        labelSearchInputs(vm.$el);
      },
      beforeDestroy() {
        unsubscribe?.();
        unsubscribe = undefined;
        overrideListener?.();
        overrideListener = undefined;
        badgeListener?.();
        badgeListener = undefined;
      },
      data: () => ({
        sessions: [] as Array<{ id: string; connectedAt: Date; lastActivity: Date; clientName?: string; clientVersion?: string }>,
        server: {
          connected: false,
          name: "Blockbench MCP",
          version: VERSION,
        },
        // Observe shared metadata so native condition changes refresh the panel.
        tools: Object.values(tools),
        resources: Object.values(resources).map((resource) => ({
          name: resource.name,
          description: resource.description,
          uriTemplate: resource.uriTemplate,
        })),
        prompts: Object.values(prompts).map((prompt) => ({
          name: prompt.name,
          description: prompt.description,
          enabled: prompt.enabled,
          status: prompt.status,
          argumentCount: Object.keys(prompt.arguments).length,
        })),
        /** Driven by the toolbar's native Toggle, which persists across restarts. */
        showExperimental: isShowExperimentalEnabled(),
        toolsFilter: { search: "" } as ISectionFilter,
        resourcesFilter: { search: "" } as ISectionFilter,
        promptsFilter: { search: "" } as ISectionFilter,
      }),
      computed: {
        filteredTools(): Array<{ name: string; description: string; enabled: boolean; status: string }> {
          // @ts-ignore - Vue component context
          const { tools, toolsFilter, showExperimental } = this;
          const searchLower = toolsFilter.search.toLowerCase();
          return tools.filter((tool: { name: string; status: string; enabled: boolean }) => {
            if (!tool.enabled || (tool.status === "experimental" && !showExperimental)) return false;
            return !searchLower || tool.name.toLowerCase().includes(searchLower);
          });
        },
        filteredResources(): Array<{ name: string; description: string; uriTemplate: string }> {
          // @ts-ignore - Vue component context
          const { resources, resourcesFilter } = this;
          const searchLower = resourcesFilter.search.toLowerCase();
          if (!searchLower) return resources;
          return resources.filter((resource: { name: string }) =>
            resource.name.toLowerCase().includes(searchLower)
          );
        },
        filteredPrompts(): Array<{ name: string; description: string; enabled: boolean; status: string; argumentCount: number }> {
          // @ts-ignore - Vue component context
          const { prompts, promptsFilter, showExperimental } = this;
          const searchLower = promptsFilter.search.toLowerCase();
          return prompts.filter((prompt: { name: string; status: string }) => {
            if (prompt.status === "experimental" && !showExperimental) return false;
            return !searchLower || prompt.name.toLowerCase().includes(searchLower);
          });
        },
      },
      methods: {
        // Expose tl() to Vue template
        tl(key: string, variables?: string | number | (string | number)[]): string {
          return tl(key, variables);
        },
        getDisplayName(toolName: string): string {
          return toolName.replace("blockbench_", "");
        },
        formatSessionId(session: { id: string; clientName?: string; clientVersion?: string }): string {
          if (session.clientName) {
            return session.clientVersion
              ? `${session.clientName} v${session.clientVersion}`
              : session.clientName;
          }
          return session.id.slice(0, 8) + "...";
        },
        formatTime(date: Date): string {
          return new Date(date).toLocaleTimeString();
        },
        openToolTest(toolName: string): void {
          openToolTestDialog(toolName);
        },
        openPromptPreview(promptName: string): void {
          openPromptPreviewDialog(promptName);
        },
        openPromptOverride(promptName: string): void {
          openPromptOverrideDialog(promptName);
        },
        isPromptOverridden(promptName: string): boolean {
          return hasPromptOverride(promptName);
        },
        formatArgumentCount,
        /** Clears a section's search when it collapses so reopening shows the full list. */
        onSectionToggle(event: Event, filter: ISectionFilter): void {
          const details = event.target as HTMLDetailsElement;
          if (!details.open) filter.search = "";
        },
      },
      name: "mcp_panel",
      template,
    },
  });

  return panel;
}

export function uiTeardown() {
  overrideDialogTeardown();
  statusBarTeardown();
  // Panel.delete() only removes DOM; destroy the Vue instance so beforeDestroy releases listeners.
  (panel?.vue as unknown as { $destroy?: () => void } | undefined)?.$destroy?.();
  panel?.delete();
  panel = undefined;
  panelToolbarTeardown();
  panelStyles?.delete();
  panelStyles = undefined;
}
