import type { FastMCP } from "fastmcp";
import type { IMCPTool, IMCPPrompt, IMCPResource } from "@/types";
let panel: Panel | undefined;

export function uiSetup({
  server,
  tools,
  resources,
  prompts
}: {
  server: FastMCP;
  tools: Record<string, IMCPTool>;
  resources: Record<string, IMCPResource>;
  prompts: Record<string, IMCPPrompt>;
}) {
  Blockbench.addCSS(/* css */ `
    .mcp-panel {
        display: grid;
        overflow: auto;
        padding: 10px;

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
    }
`);
  panel = new Panel("mcp_panel", {
    id: "mcp_panel",
    icon: "robot",
    name: "MCP",
    default_side: "right",
    resizable: true,
    component: {
      beforeMount() {
        server.on("connect", () => {
          this.server.connected = true;
          this.sessions = server.sessions ?? [];

          console.log(this.sessions);
        });

        server.on("disconnect", () => {
          this.server.connected = false;
          this.sessions = [];
        });
      },
      beforeDestroy() {
        this.destroyInspector();
      },
      data: () => ({
        sessions: [],
        server: {
          connected: false,
          name: server.options.name,
          version: server.options.version,
        },
        tools: Object.values(tools).map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
        resources: [],
        prompts: [],
      }),
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
        <details name="mcp_panel">
            <summary>Tools</summary>

            <div v-for="tool in tools" :key="tool.name">
                <dl :title="tool.description">
                    <dt>{{tool.name}}</dt>
                    <dd>{{tool.description}}</dd>
                </dl>
            </div>
            <div v-else>
                <p>No tools available.</p>
            </div>
        </details>
    </div>`,
    },
    expand_button: true,
  });

  return panel;
}

export function uiTeardown() {
  panel?.delete();
}
