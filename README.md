# Blockbench MCP

<img width="2554" height="1390" alt="Blockbench MCP Plugin screenshot" src="https://github.com/user-attachments/assets/fc897c9c-e4be-403d-803b-e981047a4575" />

<details>
  <summary>Demo Reel</summary>

  https://github.com/user-attachments/assets/c67d0dd8-ee50-40ba-b308-a84a21772901

> All scenes, models, and textures created through Blockbench MCP plugin using agent skills. (Rendered in Blender)
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

#### Codex

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

## Extending from another plugin

Any Blockbench plugin can add its own MCP tools. The MCP Server plugin installs a global `MCP` API when it loads and drains an `MCP_QUEUE` array, so registration works whichever plugin Blockbench loads first. Nothing is bundled or imported: your plugin stays independent of this one.

1. Copy [`blockbench-mcp-api.d.ts`](https://jasonjgardner.github.io/blockbench-mcp-plugin/blockbench-mcp-api.d.ts) (also shipped in `dist/` and with each release) into your plugin source for types. Its schema types come from `zod`, so add it as a dev dependency: `bun add -d zod`. At runtime you use `mcp.z`, MCP's own instance, and never bundle zod.
2. In your plugin's `onload`, queue a setup entry:

```ts
onload() {
  (globalThis.MCP_QUEUE ??= []).push({
    plugin: "my_plugin",
    setup(mcp) {
      mcp.registerTool({
        name: "my_plugin_bake",
        description: "Bakes the selected groups into keyframes of a new animation.",
        parameters: mcp.z.object({
          fps: mcp.z.number().int().min(1).max(120).default(24).describe("Keyframes per second."),
        }),
        condition: { project: true, modes: ["animate"] },
        annotations: { title: "Bake Selection" },
        execute: ({ fps }) => mcp.createJsonResult(bakeSelection(fps)),
      });
    },
  });
}
```

That is the whole integration. Tools registered with a `plugin` id are removed when that plugin unloads; `registerTool` also returns a disposer for `onunload`. Connected MCP clients receive `tools/list_changed`, and the MCP panel lists the tool with a badge naming your plugin.

To publish an existing Blockbench `Action` instead of writing a tool, use `mcp.exposeAction("my_action_id")`: the tool follows the action's own condition and runs `action.trigger()`. Pass `execute` to run something other than the click handler, for example when the action normally opens a dialog.

Things worth knowing:

- Tool names share one namespace with the built-in tools and must match `^[a-zA-Z0-9_-]{1,64}$`. Prefix yours with your plugin id; a clash throws at registration.
- `parameters` must be a Zod object schema. Build it with `mcp.z` so it is not validated by a second, bundled copy of zod.
- Wrap edits in `mcp.runUndoableEdit(aspects, label, edit)` so a failing call reverts cleanly and the write is credited by [AI usage disclosure](https://jasonjgardner.github.io/blockbench-mcp-plugin/) like a built-in tool.
- `condition` uses Blockbench's native rules (`modes`, `formats`, `features`, `project`, `method`), so an unavailable tool is hidden from clients without running your code.
- Return a string for text, or `mcp.createJsonResult({...})` for data that clients can read as structured content.
- Reloading the MCP plugin re-runs queued entries, so your tools come back without reloading your plugin. Entries in the `{ plugin, setup }` form are dropped when your plugin unloads; a bare function entry should check that your plugin is still loaded before registering.

A complete example lives in the [Havok Physics Animations plugin](https://github.com/jasonjgardner/blockbench-plugins), which registers `havok_simulate_physics` this way.

## Headless mode

The plugin drives the Blockbench app, so every tool call runs on the editor's single thread against the one active project. Only one agent can work at a time, and the user has to wait while it does.

Headless mode is a separate MCP server that works on `.bbmodel` files directly, without Blockbench. It runs in Bun and speaks MCP over stdio. Each agent can start its own server process, so several agents can build, check and render models at the same time while you keep using Blockbench.

```bash
bun install
bun run headless --root ./models
```

Configure it in an MCP client as a stdio server. `--root` is required and may be repeated. Paths in tool calls are resolved against the first root, and the server refuses paths outside every root, including through symbolic links.

```json
{
  "mcpServers": {
    "blockbench-headless": {
      "command": "bun",
      "args": ["run", "/path/to/blockbench-mcp-plugin/headless/index.ts", "--root", "/path/to/models"]
    }
  }
}
```

Or skip the checkout and start it with npx (it installs its own Bun, so only Node is needed):

```bash
npx -y github:jasonjgardner/blockbench-mcp-plugin --root "<folder>"
```

```json
{ "mcpServers": { "blockbench-headless": { "command": "npx", "args": ["-y", "github:jasonjgardner/blockbench-mcp-plugin", "--root", "/path/to/models"] } } }
```

`bun run build:headless` bundles the server into one file, `dist/headless/blockbench-mcp-headless.js`, which you can run with `bun` instead of the source.

| Tool | What it does |
|---|---|
| `bbmodel_info`, `bbmodel_outline`, `bbmodel_find_elements`, `bbmodel_get_node`, `bbmodel_list_textures`, `bbmodel_list_animations` | Read a model file |
| `bbmodel_sample_pose` | Evaluate an animation at a time and report bone positions and bounds |
| `bbmodel_create`, `bbmodel_edit`, `bbmodel_add_texture` | Create a model, apply a batch of edits atomically, embed a PNG. Edits cover groups, cubes and face UVs, textures (including replacing an image, tiling with `wrap_mode`, emissive `render_mode`), PBR materials with color, normal or height, and MER channels, animations and keyframes, locators and particle keyframes. |
| Meshes (`bbmodel_edit` operations) | `add_mesh` from vertices and faces, `add_mesh_primitive` (Blockbench's Add Mesh shapes, same geometry and UVs), `edit_mesh` (set, move, delete and transform vertices; add, delete and flip faces; merge by distance, extrude, subdivide, loop cut) and `map_mesh_uv` (Blockbench's Auto UV, axis projections or explicit UVs). Meshes are allowed in the Generic (`free`) format only. |
| `bbmodel_particle_effect`, `bbmodel_particle_pack` | Write Bedrock particle effects (the Snowstorm format) from presets or design knobs next to a model, and deliver the effects a model uses to a resource pack with the client entity `particle_effects` map. The desktop plugin has the same authoring plus a live preview (`create_particle_effect`, `add_locator`, `manage_particle_keyframes`, `export_particle_pack`). |
| `bbmodel_validate` | Geometry checks: broken outliner, slivers, block-size limits, floating parts, parts passing through each other, broken left/right symmetry. `self_test` proves each check still detects its defect on this model. GeckoLib rules run for GeckoLib models. |
| `bbmodel_validate_animations` | Samples each clip and flags parts sinking into the ground or limbs detaching from their parent |
| `bbmodel_convert_legacy` | Writes a copy Blockbench 4.x can open |
| `bbmodel_export_bedrock_geometry` | Compiles Bedrock `.geo.json` with the same conventions as Blockbench's exporter |
| `bbmodel_export_java_block`, `bbmodel_import_java_block` | Java Edition block/item model `.json` out and in, ported from Blockbench's Java Block/Item codec (rotation per `java_block_version`, cullface, tintindex, display, groups; parent models and textures resolved from resource packs) |
| `bbmodel_export_modded_entity` | Java entity model class from Blockbench's Modded Entity templates (Forge 1.7–1.17+, Fabric Yarn) |
| `bbmodel_render`, `bbmodel_contact_sheet` | Render one view, or several views at once, to PNG |
| `bbmodel_web_url` | Link that opens a model in the Blockbench web app with the file inside the URL |
| `blockbench_launch` | Start the Blockbench desktop app, optionally opening a file, and wait for its MCP plugin if asked |

**Opening a model in the web app.** Every tool that writes a model (`bbmodel_create`, `bbmodel_edit`, `bbmodel_add_texture`, `bbmodel_convert_legacy`, `bbmodel_export_bedrock_geometry`) returns a `web_app` field, and `bbmodel_web_url` makes one for any file. The links use the web app's `loaddata` parameter, so the model travels inside the URL and is never uploaded. It sits after the `#`, so it never reaches a server either. Texture paths from your machine are left out. The field has tiers, because embedded textures make URLs long:

- `url` opens the complete model. It is included when it is 8,000 characters or shorter (`--web-url-inline-max`).
- `geometry_url` opens the model without its texture images, when `url` is too long but this fits. Otherwise `geometry_length` gives its length, and `bbmodel_web_url` with that `inline_max` returns it.
- `launcher` is a local `.html` page that forwards to the complete model's URL. It is written when that URL is under about 2 MB, the limit of Chromium browsers (`--web-url-max`). Open its `file_url` in Chrome or Edge.
- Past that limit, `note` points to `blockbench_launch` instead. The pool deck from the sample scenes is 10 MB of textures and needs the desktop app.

The server tells agents to put these links in their replies. Pass `--no-web-links` to leave them out of write results, or `--web-app-url` to use another copy of the web app.

**Launching the desktop app.** `blockbench_launch` starts Blockbench with a workspace file as its last argument. If Blockbench is already running, the file opens as a new tab in that window. The app is found from `--blockbench <path>`, then `BLOCKBENCH_PATH`, then `blockbench` on `PATH`, then the standard install folders: `%LOCALAPPDATA%\Programs\Blockbench` on Windows, `/Applications/Blockbench.app` on macOS, and the package, snap, flatpak and AppImage locations on Linux. With `wait_for_mcp_ms`, the tool waits until the desktop plugin's MCP server answers (`--blockbench-mcp-url`, default `http://localhost:3000/bb-mcp`), so an agent can go on to drive the app through the plugin.

**Format rules.** `bbmodel_edit` refuses a batch when the nodes it adds or changes break the model format's limits, the way Blockbench's editor would: meshes only in `free` models; `java_block` cubes inside -16..32 with the rotations their `java_block_version` allows and no group rotation; forced box UV and whole-number sizes where a format requires them. Nothing is written, and the error says how to fix each element. Softer problems come back as `format_warnings`. Files that already break a rule stay editable, because only touched nodes are checked.

**Several agents on one file.** Every read returns a `revision`. Pass it as `expected_revision` when you write. If another agent changed the file in the meantime, the write is refused instead of silently overwriting their work. Writes go to a temporary file and are renamed into place, so readers never see half a file.

**Rendering.** The render tools use a built-in WebGPU renderer (a trimmed port of bb-render, in `headless/render/engine`). It needs Node 23.6 or newer with npm, and a GPU, because Bun cannot load its WebGPU module yet. The first render installs its three packages (`three`, `three-blockbench` and Dawn, about 130 MB) into a per-user cache folder (`%LOCALAPPDATA%lockbench-mcp-headless` on Windows, `~/.cache/blockbench-mcp-headless` elsewhere); set `BB_RENDER_HOME` or pass `--render-home <dir>` to put them somewhere else. Nothing is added to this package's own install. It renders stills of `.bbmodel` files to PNG, with PNG textures only; the full bb-render (video, path tracing, glTF/USD) is still available by passing `--bb-render <path to dist/cli.js>` or setting `BB_RENDER_CLI`. Every other tool works without any of this.

**Limits.**

- Blockbench does not reload a file that changed on disk. Reopen it after headless edits, and do not edit the same file in both at once.
- Edits cover cubes, groups, locators, textures, bone animations and particle keyframes. Meshes are measured by the checks but cannot be edited headlessly. Other element types are kept intact. Particles cannot be rendered headlessly; open the model in Blockbench to preview them.
- The animation checks sample numeric keyframes only. Bezier curves are sampled as straight lines, and channels with Molang expressions are skipped. Both are listed in the result.
- Written models get the same `ai_used` and `ai_agents` fields the plugin adds. Pass `--no-ai-disclosure` to turn this off.

Run `bun run headless --help` for every option.

Agents without an MCP connection to the server, such as subagents or shell scripts, can call any tool through `headless/call.ts`. It starts the server, calls one tool, prints the result and exits. Arguments can be inline JSON or `@file.json`.

```bash
bun run headless/call.ts --root ./models --list
bun run headless/call.ts --root ./models bbmodel_edit @ops.json
```

Normal maps for free-format models use the OpenGL convention (green up). Blockbench flips the green channel only for Bedrock formats.

## Plugin Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed instructions on setting up the development environment and how to add new tools, resources, and prompts.
