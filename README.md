# Blockbench MCP

<img width="2554" height="1390" alt="Blockbench MCP Plugin screenshot" src="https://github.com/user-attachments/assets/fc897c9c-e4be-403d-803b-e981047a4575" style="aspect-ratio:2554/1390;width:100%;height:auto;" />

<details>
  <summary>Demo Reel</summary>

  https://github.com/user-attachments/assets/c67d0dd8-ee50-40ba-b308-a84a21772901

> All scenes, models, and textures created through Blockbench MCP plugin using agent skills. (Rendered in Blender)
</details>

[![skills.sh](https://skills.sh/b/jasonjgardner/blockbench-mcp-project)](https://skills.sh/jasonjgardner/blockbench-mcp-project)

## Plugin Installation

Open the desktop version of Blockbench, go to File > Plugins and click the "Load Plugin from URL" and paste in this URL:

**[https://jasonjgardner.github.io/blockbench-mcp-plugin/mcp.js](https://jasonjgardner.github.io/blockbench-mcp-plugin/mcp.js)**

## Model Context Protocol Servers

This repository contains two MCP server options.

### Headless `.bbmodel` (stdio)

A separate stdio MCP server edits, validates, converts and renders `.bbmodel` files directly, without Blockbench running. Each agent can start its own process, so several can work in parallel while you keep using the editor. Run it straight from GitHub:

```bash
npx -y github:jasonjgardner/blockbench-mcp-plugin --root ./models
```

See [headless/README.md](headless/README.md) for client configuration, the tool list and limits.

### Blockbench Desktop Plugin (HTTP)

Configure the MCP server under Blockbench settings: **Settings** > **General** > **MCP Server Port** and **MCP Server Endpoint**.

> The following installation settings examples use the default values of `:3000/bb-mcp`

## Installation

The examples below configure the desktop plugin over **HTTP** and the headless server over **stdio**. You can use either server or both. HTTP requires Blockbench running with the plugin installed; stdio requires Node.js with npm and starts its own server process.

For headless examples, replace `/path/to/models` with an absolute path to your model directory (for example, `C:/Users/you/models` on Windows). `--root` is required and limits file access to that directory. 

> On Windows, clients that cannot launch `npx` directly should use `"command": "cmd"` and prepend `"/c", "npx"` to `args`, as shown for Claude Desktop.

<details>
<summary>General</summary>

```bash
# Desktop plugin (HTTP)
npx mcp-add --type http --url "http://localhost:3000/bb-mcp" --scope project

# Headless (stdio)
npx mcp-add --name bbmodel --type stdio --command "npx -y github:jasonjgardner/blockbench-mcp-plugin --root /path/to/models" --scope project
```
</details>

<details>
<summary>VS Code</summary>

**`.vscode/mcp.json`**

```json
{
  "servers": {
    "blockbench": {
      "url": "http://localhost:3000/bb-mcp",
      "type": "http"
    },
    "bbmodel": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "github:jasonjgardner/blockbench-mcp-plugin",
        "--root",
        "${input:rootDir}"
      ]
    }
  },
  "inputs": [
    {
      "id": "rootDir",
      "type": "promptString",
      "description": "Root directory for headless Blockbench models",
      "default": "${workspaceFolder}/models"
    }
  ]
}
```
</details>

<details>
<summary>Claude Desktop</summary>

**`claude_desktop_config.json`** (macOS/Linux)

```json
{
  "mcpServers": {
    "blockbench": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/bb-mcp"]
    },
    "bbmodel": {
      "command": "npx",
      "args": ["-y", "github:jasonjgardner/blockbench-mcp-plugin", "--root", "/path/to/models"]
    }
  }
}
```

**`claude_desktop_config.json`** (Windows)
```json
{
  "mcpServers": {
    "blockbench": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "mcp-remote", "http://localhost:3000/bb-mcp"]
    },
    "bbmodel": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "github:jasonjgardner/blockbench-mcp-plugin", "--root", "C:/Users/you/models"]
    }
  }
}
```
</details>

<details>
<summary>Claude Code</summary>

```bash
# Desktop plugin (HTTP)
claude mcp add blockbench --transport http http://localhost:3000/bb-mcp

# Headless (stdio)
claude mcp add bbmodel --transport stdio -- npx -y github:jasonjgardner/blockbench-mcp-plugin --root /path/to/models
```
</details>

<details>
<summary>Codex</summary>

```bash
codex plugin marketplace add jasonjgardner/blockbench-mcp-project --ref codex
codex plugin add blockbench-mcp@blockbench-mcp-project
```

Or register the servers directly:

```bash
# Desktop plugin (HTTP)
codex mcp add blockbench --url http://localhost:3000/bb-mcp

# Headless (stdio)
codex mcp add bbmodel -- npx -y github:jasonjgardner/blockbench-mcp-plugin --root /path/to/models
```
</details>

<details>
<summary><a href="https://antigravity.google/docs/mcp#connecting-custom-mcp-servers">Antigravity</a></summary>

```json
{
  "mcpServers": {
    "blockbench": {
      "serverUrl": "http://localhost:3000/bb-mcp"
    },
    "bbmodel": {
      "command": "npx",
      "args": ["-y", "github:jasonjgardner/blockbench-mcp-plugin", "--root", "/path/to/models"]
    }
  }
}
```
</details>

<details>
<summary>Cline</summary>

<img width="674" height="486" alt="Connecting to Blockbench MCP plugin through Cline" src="https://github.com/user-attachments/assets/f27f2304-dd56-4c60-b159-86fbd5af65ee" />

**`cline_mcp_settings.json`**

```json
{
  "mcpServers": {
    "blockbench": {
      "url": "http://localhost:3000/bb-mcp",
      "type": "streamableHttp",
      "disabled": false,
      "autoApprove": []
    },
    "bbmodel": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:jasonjgardner/blockbench-mcp-plugin", "--root", "/path/to/models"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```
</details>

<details>
<summary>Ollama</summary>

```bash
# Desktop plugin (HTTP)
uvx ollmcp -u http://localhost:3000/bb-mcp

# Headless (stdio): register, then start the client
uvx ollmcp mcp add bbmodel -- npx -y github:jasonjgardner/blockbench-mcp-plugin --root /path/to/models
uvx ollmcp
```

Recommended: [jonigl/mcp-client-for-ollama](https://github.com/jonigl/mcp-client-for-ollama)
</details>

<details>
<summary>OpenCode</summary>

```bash
opencode mcp add
```

Choose a remote server for the desktop HTTP URL, or a local server for the headless command. You can also configure both in **`opencode.json`**:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "blockbench": {
      "type": "remote",
      "url": "http://localhost:3000/bb-mcp",
      "enabled": true
    },
    "bbmodel": {
      "type": "local",
      "command": ["npx", "-y", "github:jasonjgardner/blockbench-mcp-plugin", "--root", "/path/to/models"],
      "enabled": true
    }
  }
}
```

See the [OpenCode MCP configuration reference](https://opencode.ai/docs/mcp-servers/) for local and remote server options.

<img width="504" height="300" alt="Connecting to Blockbench MCP plugin through OpenCode." src="https://github.com/user-attachments/assets/238971fc-0048-4b8d-95dd-6681604bbe90" />
</details>



## Usage

[See sample project](https://github.com/jasonjgardner/blockbench-mcp-project) for prompt examples.

### [Skills](https://skills.sh/jasonjgardner/blockbench-mcp-project)

Use Agent Skills to orchestrate tool usage.

## Extending from another plugin

Other Blockbench plugins can register their own MCP tools through a global `MCP_QUEUE`, without bundling or importing this plugin. See [docs/plugin.md](docs/plugin.md) for the API and an example.

> [!NOTE]
> Plugins in the official Blockbench plugin repository are not allowed to use AI features, so a plugin that registers MCP tools has to be distributed some other way.

## Plugin Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed instructions on setting up the development environment and how to add new tools, resources, and prompts.

## Security

The desktop plugin's HTTP server listens on this computer only (`127.0.0.1` and `::1`) by default, so `http://localhost:3000/bb-mcp` works whether a client resolves `localhost` to IPv4 or IPv6. Requests with a non-loopback `Origin` or `Host` header get `403 Forbidden`, which keeps web pages, including DNS rebinding attacks, from driving Blockbench through your browser.

To accept connections from other computers (for example a client inside WSL2 without mirrored networking, a VM, or another machine), set **Settings** > **General** > **MCP Server Host** to `0.0.0.0` or `::` and reload the plugin. In that mode the `Host` header is no longer checked, since other computers reach the server by its address, but requests with a non-loopback `Origin` header are still refused. The server has no authentication: anyone who can reach the port can call every tool, including `risky_eval`. Only do this on a trusted network and keep your firewall rules restrictive.

`risky_eval` runs any JavaScript a client sends. To turn it off, clear **Settings** > **General** > **Enable risky_eval**: connected clients stop seeing the tool and its calls are refused.
