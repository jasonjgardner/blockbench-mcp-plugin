## Model Context Protocol Server
Configure experimental MCP server under Blockbench settings: __Settings__ > __General__ > __MCP Server Port__ and __MCP Server Endpoint__

The following examples use the default values of `:3000/mcp`

> __Be sure your Blockbench settings match the port and endpoint used in the MCP JSON configuration.__

## Installation

### Claude Desktop

__`claude_desktop_config.json`__

```json
{
  "mcpServers": {
    "blockbench": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:3000/mcp"
      ]
    }
  }
}
```

### VS Code

<span style="background: darkred; box-shadow: 1px 1px 6px rgba(0 0 0 / 50%); color: pink; font: 600 12px sans-serif; padding: 0.3em 0.5em; border-radius: 0.25em; outline: 0.125em solid red;">Unstable</span>

> This plugin _should_ be compatible but Copilot often throws errors when using most tools.

__`.vscode/mcp.json`__

```json
{
    "servers": {
        "blockbench": {
            "url": "http://localhost:3000/mcp"
        },
    }
}
```

## Basic Usage

1. Start Blockbench
2. Start your MCP client
3. Enable/disable tools in client
4. Prompt to create models

### Limitations / Expectations

Only a small fraction of Blockbench's API has been mapped to a MCP server tool, so some capabilities may be limited.

"One-shotting" a model is possible but human-in-the-loop interaction and project clean-up should usually be expected.

### Tips

- __Set the agent up for success__ by adding textures and groups to the project ahead of prompting.
- __Find the right amount of context__ by disabling tools you do not want or need, _but also_ try providing lots of specific project details and even __use other MCP servers in the same context.__ (i.e. File or web access tools.)
- __Make a backup.__ This is experimental tech! Working in existing projects may yield unexpected results.