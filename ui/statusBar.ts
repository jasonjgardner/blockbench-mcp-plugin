import type { FastMCP } from "fastmcp";

let statusBarElement: HTMLDivElement | undefined;

interface StatusBarData {
  connected: boolean;
  serverName: string;
  port: number;
  endpoint: string;
}

export function statusBarSetup(server: FastMCP): void {
  const port = Settings.get("mcp_port") || 3000;
  const endpoint = Settings.get("mcp_endpoint") || "/bb-mcp";

  // Add CSS for the status bar
  Blockbench.addCSS(/* css */ `
    #mcp-status-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      background-color: var(--color-dark);
      border-block-start: 1px solid var(--color-border);
      font-size: 0.85em;
      user-select: none;
    }

    #mcp-status-bar .mcp-status-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      padding: 2px 8px;
      border-radius: 4px;
      transition: background-color 0.2s;
    }

    #mcp-status-bar .mcp-status-indicator:hover {
      background-color: var(--color-button);
    }

    #mcp-status-bar .mcp-status-dot {
      inline-size: 8px;
      block-size: 8px;
      border-radius: 50%;
      background-color: var(--color-subtle_text);
      transition: background-color 0.3s;
    }

    #mcp-status-bar .mcp-status-dot.connected {
      background-color: #4caf50;
      box-shadow: 0 0 8px rgba(76, 175, 80, 0.6);
      animation: pulse 2s ease-in-out infinite;
    }

    #mcp-status-bar .mcp-status-dot.disconnected {
      background-color: #f44336;
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.5;
      }
    }

    #mcp-status-bar .mcp-status-text {
      color: var(--color-text);
      font-weight: 500;
    }

    #mcp-status-bar .mcp-server-info {
      color: var(--color-subtle_text);
      font-size: 0.9em;
      margin-inline-start: 4px;
    }
  `);

  // Create the status bar element
  statusBarElement = document.createElement("div");
  statusBarElement.id = "mcp-status-bar";

  // Create the status indicator
  const statusIndicator = document.createElement("div");
  statusIndicator.className = "mcp-status-indicator";
  statusIndicator.title = "Click to view MCP panel";
  
  const statusDot = document.createElement("div");
  statusDot.className = "mcp-status-dot";
  
  const statusText = document.createElement("span");
  statusText.className = "mcp-status-text";
  statusText.textContent = "MCP Server";
  
  const serverInfo = document.createElement("span");
  serverInfo.className = "mcp-server-info";
  serverInfo.textContent = `(${port}${endpoint})`;

  statusIndicator.appendChild(statusDot);
  statusIndicator.appendChild(statusText);
  statusIndicator.appendChild(serverInfo);
  
  statusBarElement.appendChild(statusIndicator);

  // Function to update status
  const updateStatus = (connected: boolean) => {
    if (connected) {
      statusDot.classList.remove("disconnected");
      statusDot.classList.add("connected");
      statusText.textContent = "MCP Server Connected";
    } else {
      statusDot.classList.remove("connected");
      statusDot.classList.add("disconnected");
      statusText.textContent = "MCP Server Disconnected";
    }
  };

  // TODO: Official SDK doesn't have event emitter - implement connection tracking differently
  // For now, assume connected since we're using HTTP transport
  updateStatus(true);

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
  
  // Set initial status (disconnected by default until first connect event)
  updateStatus(false);
}

export function statusBarTeardown(): void {
  if (!statusBarElement) {
    return;
  }

  statusBarElement.remove();
  statusBarElement = undefined;
}
