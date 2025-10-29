import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IMCPTool, IMCPPrompt, IMCPResource } from "@/types";
import { VERSION } from "@/lib/constants";
import { statusBarSetup, statusBarTeardown } from "@/ui/statusBar";

let panel: Panel | undefined;

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
  Blockbench.addCSS(/* css */ `
    .mcp-panel {
        display: grid;
        grid-template-rows: auto 1fr auto;
        max-block-size: 66vh;
        overflow: auto;
        padding: 10px;

        details {
          overflow: auto;
        }

        dl {
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-auto-flow: row;
            margin: 0;
            padding: 0;

            dt {
                font-size: 0.825em;
                font-weight: bold;
                grid-column: 1;
                margin: 0;
                padding: 0;
            }

            dd {
                grid-column: 2;
                margin: 0;
                padding: 0;
            }
        }

        .stable {
          border: 1px solid green;
          border-radius: 4px;
          background: hsla(from green h 90% 80% / 0.5);
          color: hsl(from green h 30% 20%);
        }

        .experimental {
          border: 1px solid orange;
          border-radius: 4px;
          background: hsla(from orange h 90% 80% / 0.5);
          color: hsl(from orange h 30% 20%);
        }

        .tool-toggle-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 0;
          border-bottom: 1px solid var(--color-border);
        }

        .tool-toggle-row:last-child {
          border-bottom: none;
        }

        .tool-info {
          flex: 1;
          min-width: 0;
        }

        .tool-name {
          font-weight: bold;
          font-size: 0.9em;
          margin-bottom: 2px;
        }

        .tool-description {
          font-size: 0.8em;
          color: var(--color-subtle_text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .tool-toggle {
          margin-left: 12px;
          flex-shrink: 0;

          label {
            font-size: 0.9em;
          }
        }

        .tool-status {
          display: inline-block;
          padding: 2px 4px;
          border-radius: 3px;
          font-size: 0.666em;
          font-weight: bold;
          text-transform: uppercase;
          margin-left: 8px;
        }
    }
`);

  // Setup the status bar
  statusBarSetup(server);

  panel = new Panel("mcp_panel", {
    id: "mcp_panel",
    icon: "robot",
    name: "MCP",
    default_side: "right",
    resizable: true,
    component: {
      beforeMount() {
        // TODO: Official SDK doesn't have event emitter - implement connection tracking differently
        // For now, set connected state directly since we're using HTTP transport
        // @ts-ignore
        this.server.connected = true;
        // @ts-ignore
        this.sessions = [];

        // Initialize tools data with current enabled state
        // @ts-ignore
        this.tools = Object.values(tools).map((tool) => ({
          name: tool.name,
          description: tool.description,
          enabled: tool.enabled,
          status: tool.status,
        }));

        // Initialize resources data
        // @ts-ignore
        this.resources = Object.values(resources).map((resource) => ({
          name: resource.name,
          description: resource.description,
          uriTemplate: resource.uriTemplate,
        }));
      },
      data: () => ({
        inspector: null,
        inspectorLink: "http://127.0.0.1:6274/",
        sessions: [],
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
        prompts: [],
      }),
      methods: {
        getDisplayName(toolName: string): string {
          return toolName.replace("blockbench_", "");
        },
      },
      name: "mcp_panel",
      template: /*html*/ `<div class="mcp-panel">
        <details name="mcp_panel">
          <summary>Server</summary>
            <dl>
                <dt>Server Name</dt>
                <dd>{{server.name}}</dd>
                <dt>Server Version</dt>
                <dd>{{server.version}}</dd>
                <dt>Server Status</dt>
                <dd>
                    <span v-if="server.connected" class="connected">Connected</span>
                    <span v-else class="disconnected">Disconnected</span>
                </dd>
            </dl>
        </details>
        <details name="mcp_panel" open>
            <summary>Tools</summary>

            <div v-if="tools.length > 0">
                <div v-for="tool in tools" :key="tool.name" class="tool-toggle-row">
                    <div class="tool-info">
                        <div class="tool-name">
                            {{getDisplayName(tool.name)}}
                            <span :class="['tool-status', tool.status]">{{tool.status}}</span>
                        </div>
                        <div class="tool-description" :title="tool.description">{{tool.description}}</div>
                    </div>
                </div>
            </div>
            <div v-else>
                <p>No tools available.</p>
            </div>
        </details>
        <details name="mcp_panel">
            <summary>Resources</summary>

            <div v-if="resources.length > 0">
                <div v-for="resource in resources" :key="resource.name" class="tool-toggle-row">
                    <div class="tool-info">
                        <div class="tool-name">{{getDisplayName(resource.name)}}</div>
                        <div class="tool-description" :title="resource.description">{{resource.description}}</div>
                        <div class="tool-description" style="font-style: italic; margin-top: 2px;" :title="resource.uriTemplate">{{resource.uriTemplate}}</div>
                    </div>
                </div>
            </div>
            <div v-else>
                <p>No resources available.</p>
            </div>
        </details>
    </div>`,
    },
    expand_button: true,
  });

  return panel;
}

export function uiTeardown() {
  statusBarTeardown();
  panel?.delete();
}
