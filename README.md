# Blockbench MCP

https://github.com/user-attachments/assets/ab1b7e63-b6f0-4d5b-85ab-79d328de31db

## Plugin Installation

Open the desktop version of Blockbench, go to File > Plugins and click the "Load Plugin from URL" and paste in this URL:


__[https://jasonjgardner.github.io/blockbench-mcp-plugin/mcp.js](https://jasonjgardner.github.io/blockbench-mcp-plugin/mcp.js)__


## Model Context Protocol Server
Configure the MCP server under Blockbench settings: __Settings__ > __General__ > __MCP Server Port__ and __MCP Server Endpoint__

The following examples use the default values of `:3000/bb-mcp`

### Installation

#### VS Code

__`.vscode/mcp.json`__

```json
{
    "servers": {
        "blockbench": {
            "url": "http://localhost:3000/bb-mcp",
            "type": "http"
        },
    }
}
```

#### Claude Desktop

__`claude_desktop_config.json`__

```json
{
  "mcpServers": {
    "blockbench": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:3000/bb-mcp"
      ]
    }
  }
}
```

## Usage

[See sample project](https://github.com/jasonjgardner/blockbench-mcp-project) for prompt examples.

### Edit Session Integration

The MCP server can hook into Blockbench's Edit Session feature to enable remote collaboration and automation. Edit Sessions use Peer.js to create P2P connections between Blockbench instances.

**Available Edit Session Tools:**
- `edit_session_start` - Start a new session as host
- `edit_session_join` - Join an existing session with a token
- `edit_session_status` - Get current session status
- `edit_session_send_command` - Send commands (undo/redo/quit) to all clients
- `edit_session_send_data` - Send custom data through the P2P connection
- `edit_session_send_chat` - Send chat messages to session participants
- `edit_session_quit` - Leave or close the session

**Use Cases:**
- Remote automation of collaborative modeling sessions
- Programmatic control of multi-user workflows
- Integration with external tools and CI/CD pipelines
- Custom synchronization and data sharing between Blockbench instances

See [docs/tools.md](docs/tools.md) for detailed documentation of all available tools.

## Plugin Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed instructions on setting up the development environment and how to add new tools, resources, and prompts.
