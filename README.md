# Blockbench MCP

<img width="2554" height="1390" alt="Blockbench MCP Plugin screenshot" src="https://github.com/user-attachments/assets/fc897c9c-e4be-403d-803b-e981047a4575" />

<details><summary>Video</summary>
  
https://github.com/user-attachments/assets/ab1b7e63-b6f0-4d5b-85ab-79d328de31db

</details>

[![skills.sh](https://skills.sh/b/jasonjgardner/blockbench-mcp-project)](https://skills.sh/jasonjgardner/blockbench-mcp-project)

## Plugin Installation

Open the desktop version of Blockbench, go to File > Plugins and click the "Load Plugin from URL" and paste in this URL:

**[https://jasonjgardner.github.io/blockbench-mcp-plugin/mcp.js](https://jasonjgardner.github.io/blockbench-mcp-plugin/mcp.js)**

## Model Context Protocol Server

Configure the MCP server under Blockbench settings: **Settings** > **General** > **MCP Server Port** and **MCP Server Endpoint**. The same section holds **Enable AI Scratchpad** (adds an `ai_scratchpad` mode that lifts the format's cube size, rotation, and integer-size guardrails while selected) and **Disclose AI Usage** (stamps `ai_used` and `ai_agents` onto projects that MCP tools modify or create).

The following examples use the default values of `:3000/bb-mcp`

### Installation


#### General

```bash
npx mcp-add --type http --url "http://localhost:3000/bb-mcp" --scope project
```

#### VS Code

**`.vscode/mcp.json`**

```json
{
  "servers": {
    "blockbench": {
      "url": "http://localhost:3000/bb-mcp",
      "type": "http"
    }
  }
}
```

#### Claude Desktop

**`claude_desktop_config.json`** (macOS/Linux)

```json
{
  "mcpServers": {
    "blockbench": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/bb-mcp"]
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
    }
  }
}
```

#### Claude Code

```bash
claude mcp add blockbench --transport http http://localhost:3000/bb-mcp
```

#### ChatGPT

<img width="601" height="426" alt="ChatGPT add plugin marketplace screenshot" src="https://github.com/user-attachments/assets/348471c3-f215-47bb-ae12-9c140d53186e" />

##### Codex

```bash
codex plugin marketplace add jasonjgardner/blockbench-mcp-project --ref codex
codex plugin add blockbench-mcp@blockbench-mcp-project
```

#### [Antigravity](https://antigravity.google/docs/mcp#connecting-custom-mcp-servers)

```json
{
  "mcpServers": {
    "blockbench": {
      "serverUrl": "http://localhost:3000/bb-mcp"
    }
  }
}
```

#### Cline

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
    }
  }
}
```

#### Ollama

```bash
uvx ollmcp -u http://localhost:3000/bb-mcp
```

Recommended: [jonigl/mcp-client-for-ollama](https://github.com/jonigl/mcp-client-for-ollama)

#### OpenCode

```bash
opencode mcp add
```

<img width="504" height="300" alt="Connecting to Blockbench MCP plugin through OpenCode." src="https://github.com/user-attachments/assets/238971fc-0048-4b8d-95dd-6681604bbe90" />


## Usage

[See sample project](https://github.com/jasonjgardner/blockbench-mcp-project) for prompt examples.

### [Skills](https://skills.sh/jasonjgardner/blockbench-mcp-project)

Use Agent Skills to orchestrate tool usage.

Call `get_capabilities` to discover the running application/plugin versions and supported model formats. Use `get_mesh_info` to inspect existing vertex/face keys, local bounds, normals, UVs, and texture assignments without changing selection. See [inspection tools](docs/inspection-tools.md) for examples and pagination details.

Tools follow Blockbench's native availability conditions and notify connected clients when the list changes. Read the active project's live `.bbmodel` through MCP resources, or request embedded exports. See [tool availability and project resources](docs/resources-and-availability.md) for examples and error behavior.

Use `list_modes` to discover available editor tabs, then `set_mode` with `{ "mode_id": "animate" }` to enter Animate before animation work. Switching respects the project's supported modes and updates tool availability.

## Plugin Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed instructions on setting up the development environment and how to add new tools, resources, and prompts.

### Testing

Run `bun test` for regression tests without opening Blockbench. To test the running plugin, build with `bun run build`, load or reload `dist/mcp.js` in Blockbench, and run `bun run test:live`. An optional endpoint can follow the command when using a different port or path.

The live test creates a separate Generic Model project, checks tool/resource/prompt discovery, validation, mesh transforms, selection, undo/redo, face normals, screenshots, and export. It recreates the official MCP symbol and saves the `.bbmodel`, previews, and results in `artifacts/mcp-identity/`. Generated artifacts are ignored by Git; test scripts and written reports stay versioned. Reloading the plugin expires existing MCP sessions; reconnect clients before continuing. See the [test report](docs/reports/2026-09-12-mcp-identity-test.md) for findings and scope.

Run `bun run test:inspection:live` with a mesh project open for read-only capability and geometry inspection checks. It saves results to the ignored `artifacts/inspection/` directory. An intentional reference asset needed by automated tests belongs in `tests/fixtures/` and should be committed separately from generated run outputs.

Before tagging a release, build and reload the plugin in Blockbench desktop, then run `bun run release:smoke`. This runs the regression and desktop suites and writes `releases/desktop-smoke.json`; commit that record with the tested source. Tag deployments reject missing or stale evidence. See [required desktop release checks](CONTRIBUTING.md#required-desktop-checks-before-releases).
