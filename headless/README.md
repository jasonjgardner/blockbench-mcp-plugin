# Blockbench MCP: headless mode

The desktop plugin drives the Blockbench app, so every tool call runs on the editor's single thread against the one active project. Only one agent can work at a time, and the user has to wait while it does.

Headless mode is a separate MCP server that works on `.bbmodel` files directly, without Blockbench. It speaks MCP over stdio. Each agent can start its own server process, so several agents can build, check and render models at the same time while you keep using Blockbench.

## Running it

Run it straight from GitHub. Nothing needs to be cloned or installed first.

```bash
# With Bun
bunx github:jasonjgardner/blockbench-mcp-plugin --root ./models

# With Node (the launcher installs its own Bun, so only Node is needed)
npx -y github:jasonjgardner/blockbench-mcp-plugin --root ./models
```

Add `#<branch, tag or commit>` to pin a version, for example `github:jasonjgardner/blockbench-mcp-plugin#<commit>`. Headless mode ships from 1.9 onward; older tags do not include it.

`--root` is required and may be repeated. Paths in tool calls are resolved against the first root, and the server refuses paths outside every root, including through symbolic links.

### MCP client configuration

Register it as a stdio server:

```json
{
  "mcpServers": {
    "blockbench-headless": {
      "command": "bunx",
      "args": ["github:jasonjgardner/blockbench-mcp-plugin", "--root", "/path/to/models"]
    }
  }
}
```

With Node, use `"command": "npx"` and `"args": ["-y", "github:jasonjgardner/blockbench-mcp-plugin", "--root", "/path/to/models"]`. On Windows, clients that cannot start `.cmd` shims need `"command": "cmd"` with `"/c", "npx", ...` in front of the arguments.

Claude Code:

```bash
claude mcp add blockbench-headless -- bunx github:jasonjgardner/blockbench-mcp-plugin --root /path/to/models
```

Pass `--help` for every option.

### From a checkout

When working on the server itself:

```bash
bun install
bun run headless --root ./models
bun run build:headless   # bundles to dist/headless/blockbench-mcp-headless.js
```

Agents without an MCP connection, such as subagents or shell scripts, can call one tool through `headless/call.ts`. It starts the server, calls the tool, prints the result and exits. Arguments can be inline JSON or `@file.json`.

```bash
bun run headless/call.ts --root ./models --list
bun run headless/call.ts --root ./models bbmodel_edit @ops.json
```

## Tools

| Tool | What it does |
|---|---|
| `bbmodel_info`, `bbmodel_outline`, `bbmodel_find_elements`, `bbmodel_get_node`, `bbmodel_list_textures`, `bbmodel_list_animations` | Read a model file |
| `bbmodel_sample_pose` | Evaluate an animation at a time and report bone positions and bounds |
| `bbmodel_create`, `bbmodel_edit`, `bbmodel_add_texture` | Create a model, apply a batch of edits atomically, embed a PNG. Edits cover groups, cubes and face UVs, textures (including replacing an image, tiling with `wrap_mode`, emissive `render_mode`), PBR materials with color, normal or height, and MER channels, animations and keyframes, locators and particle keyframes. |
| Meshes (`bbmodel_edit` operations) | `add_mesh` from vertices and faces, `add_mesh_primitive` (Blockbench's Add Mesh shapes, same geometry and UVs), `edit_mesh` (set, move, delete and transform vertices; add, delete and flip faces; merge by distance, extrude, subdivide, loop cut) and `map_mesh_uv` (Blockbench's Auto UV, axis projections or explicit UVs). Meshes are allowed in the Generic (`free`) format only. |
| `bbmodel_particle_effect`, `bbmodel_particle_pack` | Write Bedrock particle effects (the Snowstorm format) from presets or design knobs next to a model, and deliver the effects a model uses to a resource pack with the client entity `particle_effects` map |
| `bbmodel_validate` | Geometry checks: broken outliner, slivers, block-size limits, floating parts, parts passing through each other, broken left/right symmetry. `self_test` proves each check still detects its defect on this model. GeckoLib rules run for GeckoLib models. |
| `bbmodel_validate_animations` | Samples each clip and flags parts sinking into the ground or limbs detaching from their parent |
| `bbmodel_convert_legacy` | Writes a copy Blockbench 4.x can open |
| `bbmodel_export_bedrock_geometry` | Compiles Bedrock `.geo.json` with the same conventions as Blockbench's exporter |
| `bbmodel_export_java_block`, `bbmodel_import_java_block` | Java Edition block/item model `.json` out and in, ported from Blockbench's Java Block/Item codec |
| `bbmodel_export_modded_entity` | Java entity model class from Blockbench's Modded Entity templates (Forge 1.7–1.17+, Fabric Yarn) |
| `bbmodel_render`, `bbmodel_contact_sheet` | Render one view, or several views at once, to PNG |
| `bbmodel_web_url` | Link that opens a model in the Blockbench web app with the file inside the URL |
| `blockbench_launch` | Start the Blockbench desktop app, optionally opening a file, and wait for its MCP plugin if asked |

## Behavior

**Several agents on one file.** Every read returns a `revision`. Pass it as `expected_revision` when you write. If another agent changed the file in the meantime, the write is refused instead of silently overwriting their work. Writes go to a temporary file and are renamed into place, so readers never see half a file.

**Format rules.** `bbmodel_edit` refuses a batch when the nodes it adds or changes break the model format's limits, the way Blockbench's editor would: meshes only in `free` models; `java_block` cubes inside -16..32 with the rotations their `java_block_version` allows and no group rotation; forced box UV and whole-number sizes where a format requires them. Nothing is written, and the error says how to fix each element. Softer problems come back as `format_warnings`. Files that already break a rule stay editable, because only touched nodes are checked.

**Opening a model in the web app.** Every tool that writes a model returns a `web_app` field, and `bbmodel_web_url` makes one for any file. The links use the web app's `loaddata` parameter, so the model travels inside the URL after the `#` and never reaches a server. Texture paths from your machine are left out. Because embedded textures make URLs long, the field has tiers:

- `url` opens the complete model, when it is 8,000 characters or shorter (`--web-url-inline-max`).
- `geometry_url` opens the model without its texture images, when `url` is too long but this fits. Otherwise `geometry_length` gives its length, and `bbmodel_web_url` with that `inline_max` returns it.
- `launcher` is a local `.html` page that forwards to the complete model's URL, written when that URL is under about 2 MB, the limit of Chromium browsers (`--web-url-max`). Open its `file_url` in Chrome or Edge.
- Past that limit, `note` points to `blockbench_launch` instead.

Pass `--no-web-links` to leave these out of write results, or `--web-app-url` to use another copy of the web app.

**Launching the desktop app.** `blockbench_launch` starts Blockbench with a workspace file as its last argument; if Blockbench is already running, the file opens as a new tab. The app is found from `--blockbench <path>`, then `BLOCKBENCH_PATH`, then `blockbench` on `PATH`, then the standard install folders. With `wait_for_mcp_ms`, the tool waits until the desktop plugin's MCP server answers (`--blockbench-mcp-url`), so an agent can go on to drive the app through the plugin.

**Rendering.** The render tools use a built-in WebGPU renderer (a trimmed port of bb-render, in `render/engine`). It needs Node 23.6 or newer with npm, and a GPU, because Bun cannot load its WebGPU module yet. The first render installs `three`, `three-blockbench` and Dawn (about 130 MB) into a per-user cache folder (`%LOCALAPPDATA%\blockbench-mcp-headless` on Windows, `~/.cache/blockbench-mcp-headless` elsewhere); set `BB_RENDER_HOME` or pass `--render-home <dir>` to move it. It renders stills with PNG textures only. The full bb-render (video, path tracing, glTF/USD) can be used instead with `--bb-render <path to dist/cli.js>` or `BB_RENDER_CLI`. Every other tool works without any of this.

## Limits

- Blockbench does not reload a file that changed on disk. Reopen it after headless edits, and do not edit the same file in both at once.
- Element types other than cubes, meshes, groups and locators are kept intact but cannot be edited. Particles cannot be rendered headlessly; open the model in Blockbench to preview them.
- The animation checks sample numeric keyframes only. Bezier curves are sampled as straight lines, and channels with Molang expressions are skipped. Both are listed in the result.
- Written models get the same `ai_used` and `ai_agents` fields the plugin adds. Pass `--no-ai-disclosure` to turn this off.
- Normal maps for free-format models use the OpenGL convention (green up). Blockbench flips the green channel only for Bedrock formats.
