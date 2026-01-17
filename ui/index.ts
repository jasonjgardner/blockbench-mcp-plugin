import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IMCPTool, IMCPPrompt, IMCPResource } from "@/types";
import { VERSION } from "@/lib/constants";
import { statusBarSetup, statusBarTeardown } from "@/ui/statusBar";
import { sessionManager, type Session } from "@/lib/sessions";
import { openToolTestDialog } from "@/ui/toolTestDialog";
import { openPromptPreviewDialog } from "@/ui/promptPreviewDialog";
import importStylesheet from "@/macros/importStylesheet" with { type: "macro" };
import importHTML from "@/macros/importHTML" with { type: "macro" };

const panelCSS = importStylesheet("ui/panel.css");
const template = importHTML("ui/panel.html");

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
      }),
      methods: {
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
