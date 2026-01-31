import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sessionManager, type Session } from "@/lib/sessions";
import statusBarCSS from "@/ui/statusBar.css";

let statusBarElement: HTMLDivElement | undefined;
let unsubscribe: (() => void) | undefined;

export function statusBarSetup(server: McpServer): void {
  const port = Settings.get("mcp_port") || 3000;
  const endpoint = Settings.get("mcp_endpoint") || "/bb-mcp";

  // Add CSS for the status bar
  Blockbench.addCSS(statusBarCSS);

  // Create the status bar element
  statusBarElement = document.createElement("div");
  statusBarElement.id = "mcp-status-bar";

  // Create the status indicator
  const statusIndicator = document.createElement("div");
  statusIndicator.className = "mcp-status-indicator";
  statusIndicator.title = tl("mcp.tooltip.click_to_view_panel");

  const statusDot = document.createElement("div");
  statusDot.className = "mcp-status-dot";

  const statusText = document.createElement("span");
  statusText.className = "mcp-status-text";
  statusText.textContent = tl("mcp.status.server");
  
  const serverInfo = document.createElement("span");
  serverInfo.className = "mcp-server-info";
  serverInfo.textContent = `(${port}${endpoint})`;

  statusIndicator.appendChild(statusDot);
  statusIndicator.appendChild(statusText);
  statusIndicator.appendChild(serverInfo);
  
  statusBarElement.appendChild(statusIndicator);

  // Function to update status based on sessions
  const updateStatus = (sessions: Session[]) => {
    const count = sessions.length;
    if (count > 0) {
      statusDot.classList.remove("disconnected");
      statusDot.classList.add("connected");
      statusText.textContent = count === 1
        ? tl("mcp.status.server_one_client")
        : tl("mcp.status.server_clients", [count]);
    } else {
      statusDot.classList.remove("connected");
      statusDot.classList.add("disconnected");
      statusText.textContent = tl("mcp.status.server");
    }
  };

  // Subscribe to session changes
  unsubscribe = sessionManager.subscribe(updateStatus);

  // Click handler to open the MCP panel
  statusIndicator.addEventListener("click", () => {
    // @ts-ignore - Blockbench Panel types
    const mcpPanel = Panels.mcp_panel;
    
    if (!mcpPanel) {
      return;
    }

    // Toggle panel visibility by unfolding it if folded
    if (mcpPanel.folded) {
      mcpPanel.fold(false);
      return;
    }
    
    // If already visible and unfolded, move to front or make it visible
    if (mcpPanel.slot === 'float') {
      mcpPanel.moveToFront();
    }
  });

  // Append to the existing status bar
  const existingStatusBar = document.getElementById("status_bar");
  
  if (!existingStatusBar) {
    console.warn("Could not find status_bar element");
    return;
  }

  existingStatusBar.appendChild(statusBarElement);
}

export function statusBarTeardown(): void {
  // Unsubscribe from session changes
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = undefined;
  }

  if (statusBarElement) {
    statusBarElement.remove();
    statusBarElement = undefined;
  }
}
