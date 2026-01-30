import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IMCPTool, IMCPPrompt, IMCPResource } from "@/types";
import { VERSION } from "@/lib/constants";
import { statusBarSetup, statusBarTeardown } from "@/ui/statusBar";
import { sessionManager, type Session } from "@/lib/sessions";
import { openToolTestDialog } from "@/ui/toolTestDialog";
import { openPromptPreviewDialog } from "@/ui/promptPreviewDialog";
import { formatArgumentCount } from "@/ui/i18n";
import panelCSS from "@/ui/panel.css";
import template from "@/ui/panel.html";

let panel: Panel | undefined;
let unsubscribe: (() => void) | undefined;

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
  Blockbench.addCSS(panelCSS);

  // Setup the status bar
  statusBarSetup(server);

  panel = new Panel("mcp_panel", {
    id: "mcp_panel",
    icon: "robot",
    name: "MCP",
    default_side: "right",
    resizable: true,
    component: {
      mounted() {
        // Subscribe to session changes
        // @ts-ignore
        const vm = this;
        unsubscribe = sessionManager.subscribe((sessions: Session[]) => {
          vm.sessions = sessions.map((s: Session) => ({
            id: s.id,
            connectedAt: s.connectedAt,
            lastActivity: s.lastActivity,
            clientName: s.clientName,
            clientVersion: s.clientVersion,
          }));
          vm.server.connected = sessions.length > 0;
        });
      },
      beforeDestroy() {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
      },
      data: () => ({
        sessions: [] as Array<{ id: string; connectedAt: Date; lastActivity: Date; clientName?: string; clientVersion?: string }>,
        server: {
          connected: false,
          name: "Blockbench MCP",
          version: VERSION,
        },
        tools: Object.values(tools).map((tool) => ({
          name: tool.name,
          description: tool.description,
          enabled: tool.enabled,
          status: tool.status,
        })),
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
        // Filter states
        toolsFilter: {
          search: "",
          showExperimental: true,
        },
        resourcesFilter: {
          search: "",
        },
        promptsFilter: {
          search: "",
          showExperimental: true,
        },
      }),
      computed: {
        filteredTools(): Array<{ name: string; description: string; enabled: boolean; status: string }> {
          // @ts-ignore - Vue component context
          const { tools, toolsFilter } = this;
          const searchLower = toolsFilter.search.toLowerCase();
          return tools.filter((tool: { name: string; status: string }) => {
            // Check status filter (stable always visible, experimental based on toggle)
            if (tool.status === "experimental" && !toolsFilter.showExperimental) return false;
            // Check search filter (name only)
            if (searchLower && !tool.name.toLowerCase().includes(searchLower)) return false;
            return true;
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
          const { prompts, promptsFilter } = this;
          const searchLower = promptsFilter.search.toLowerCase();
          return prompts.filter((prompt: { name: string; status: string }) => {
            // Check status filter (stable always visible, experimental based on toggle)
            if (prompt.status === "experimental" && !promptsFilter.showExperimental) return false;
            // Check search filter (name only)
            if (searchLower && !prompt.name.toLowerCase().includes(searchLower)) return false;
            return true;
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
        formatArgumentCount,
        onToolsToggle(event: Event): void {
          const details = event.target as HTMLDetailsElement;
          if (!details.open) {
            // @ts-ignore - Vue component context
            this.toolsFilter.search = "";
          }
        },
        onResourcesToggle(event: Event): void {
          const details = event.target as HTMLDetailsElement;
          if (!details.open) {
            // @ts-ignore - Vue component context
            this.resourcesFilter.search = "";
          }
        },
        onPromptsToggle(event: Event): void {
          const details = event.target as HTMLDetailsElement;
          if (!details.open) {
            // @ts-ignore - Vue component context
            this.promptsFilter.search = "";
          }
        },
      },
      name: "mcp_panel",
      template,
    },
    expand_button: true,
  });

  return panel;
}

export function uiTeardown() {
  statusBarTeardown();
  panel?.delete();
}
