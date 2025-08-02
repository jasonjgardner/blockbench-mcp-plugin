import type { FastMCP } from "fastmcp";
import type { IMCPTool, IMCPPrompt, IMCPResource } from "@/types";
import { enableTool, disableTool } from "@/lib/factories";
let panel: Panel | undefined;

export function uiSetup({
  server,
  tools,
  resources,
  prompts,
}: {
  server: FastMCP;
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

  // Helper functions for managing enabled tools setting
  const getEnabledTools = (): string[] => {
    try {
      const setting = (globalThis as any).settings?.mcp_enabled_tools;
      if (!setting) return Object.keys(tools); // Default to all enabled if setting doesn't exist
      const value = setting.value || "[]";
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      return Array.isArray(parsed) ? parsed : Object.keys(tools);
    } catch (e) {
      console.warn("Failed to parse enabled tools setting:", e);
      return Object.keys(tools); // Default to all enabled on error
    }
  };

  const setEnabledTools = (enabledTools: string[]) => {
    try {
      const setting = (globalThis as any).settings?.mcp_enabled_tools;
      if (setting) {
        setting.set(JSON.stringify(enabledTools));
      }
    } catch (e) {
      console.warn("Failed to save enabled tools setting:", e);
    }
  };

  // Initialize tool states from settings
  const initializeToolStates = () => {
    const enabledTools = getEnabledTools();

    Object.keys(tools).forEach((toolName) => {
      if (enabledTools.includes(toolName)) {
        enableTool(toolName);
        tools[toolName].enabled = true;
      } else {
        disableTool(toolName);
        tools[toolName].enabled = false;
      }
    });
  };

  // Initialize tool states on setup
  initializeToolStates();

  panel = new Panel("mcp_panel", {
    id: "mcp_panel",
    icon: "robot",
    name: "MCP",
    default_side: "right",
    resizable: true,
    component: {
      beforeMount() {
        // @ts-ignore
        server.on("connect", () => {
          // @ts-ignore
          this.server.connected = true;
          // @ts-ignore
          this.sessions = server.sessions ?? [];

          // @ts-ignore
          console.log(this.sessions);
        });

        // @ts-ignore
        server.on("disconnect", () => {
          // @ts-ignore
          this.server.connected = false;
          // @ts-ignore
          this.sessions = [];
        });

        // Initialize tools data with current enabled state
        // @ts-ignore
        this.tools = Object.values(tools).map((tool) => ({
          name: tool.name,
          description: tool.description,
          enabled: tool.enabled,
          status: tool.status,
        }));
      },
      beforeDestroy() {
        // @ts-ignore
        this.destroyInspector();
      },
      data: () => ({
        inspector: null,
        inspectorLink: "http://127.0.0.1:6274/",
        sessions: [],
        server: {
          connected: false,
          name: server.options.name,
          version: server.options.version,
        },
        tools: Object.values(tools).map((tool) => ({
          name: tool.name,
          description: tool.description,
          enabled: tool.enabled,
          status: tool.status,
        })),
        resources: [],
        prompts: [],
      }),
      methods: {
        launchInspector() {
          // @ts-ignore
          if (this.inspector) {
            // @ts-ignore
            this.destroyInspector();
          }
          // @ts-ignore
          this.$emit("inspector:launch");
          // @ts-ignore
          this.inspector = (globalThis as any)
            .require("child_process")
            .exec("npx @modelcontextprotocol/inspector");
        },
        destroyInspector() {
          // @ts-ignore
          if (this.inspector) {
            // @ts-ignore
            this.inspector.kill();
            // @ts-ignore
            this.inspector = null;
          }
        },
        async toggleTool(toolName: string) {
          // @ts-ignore
          const tool = this.tools.find((t: any) => t.name === toolName);
          if (!tool) return;

          tool.enabled = !tool.enabled;

          // Update the actual tool state
          if (tool.enabled) {
            enableTool(toolName);
            tools[toolName].enabled = true;
          } else {
            disableTool(toolName);
            tools[toolName].enabled = false;
          }

          // Save to settings
          // @ts-ignore
          const enabledTools = this.tools
            .filter((t: any) => t.enabled)
            .map((t: any) => t.name);
          setEnabledTools(enabledTools);

          // Rebuild the server with the new tool configuration
          try {
            if ((globalThis as any).rebuildMCPServer) {
              (globalThis as any).rebuildMCPServer();
            }
          } catch (error) {
            console.error("Failed to rebuild MCP server:", error);
          }
        },
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
                    <div class="tool-toggle" :title="tool.enabled ? 'Disable tool' : 'Enable tool'">
                        <input 
                            type="checkbox" 
                            :checked="tool.enabled" 
                            @change="toggleTool(tool.name)"
                            :id="'tool_toggle_' + tool.name"
                        />
                    </div>
                </div>
            </div>
            <div v-else>
                <p>No tools available.</p>
            </div>
        </details>
        <details name="mcp_panel">
            <summary>Development</summary>
            <button v-if="!inspector" @click="launchInspector">Launch Inspector</button>
            <div v-else>
                <p>Inspector started.</p>
                <a :href="inspectorLink" target="_blank" style="margin-top: 10px; display: inline-block;">Open MCP Web UI</a>
                <button @click="destroyInspector">Stop Inspector</button>
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
