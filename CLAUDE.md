# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blockbench MCP is a plugin that integrates the Model Context Protocol (MCP) into Blockbench, enabling AI models to interact with the 3D modeling software through exposed tools, resources, and prompts. It runs an HTTP server inside Blockbench that accepts MCP requests.

## Build Commands

```bash
bun install                     # Install dependencies
bun run dev                     # Build with sourcemaps (one-time)
bun run dev:watch               # Build with watch mode
bun run build                   # Minified production build
bun run ./build.ts --clean      # Clean dist/ before building
bun run docs:build              # Generate API docs from Zod schemas
bun run docs:serve              # Serve docs locally with Tailwind
bunx @modelcontextprotocol/inspector  # Test MCP tools locally
bun run headless --root <dir>   # Headless .bbmodel MCP server over stdio (no Blockbench)
bun run build:headless          # Bundle it to dist/headless/blockbench-mcp-headless.js
bun run test:headless           # Unit + in-memory MCP tests for headless/
bun run test:headless:live      # Stdio + real renders (needs Node 23.6+, npm, GPU; first run installs the engine's packages)
```

Output goes to `dist/mcp.js`. Load in Blockbench via File > Plugins > Load Plugin from File.

## Architecture

```
index.ts              # Plugin entry - registers server, UI, settings
server/
  server.ts           # McpServer singleton (official MCP SDK)
  tools.ts            # Tool module imports aggregator
  tools/              # Tool implementations by domain (each exports schemas + toolDocs + register fn)
  resources.ts        # MCP resource definitions
  resources/          # Resource implementations by domain
  prompts.ts          # MCP prompts with argument completion
  prompts/            # Prompt implementations by domain
  net.ts              # HTTP server and transport handling
lib/
  factories.ts        # createTool(), createPrompt(), createResource(), IToolSpec/IPromptSpec/IResourceSpec
  zodObjects.ts       # Reusable Zod schemas
  util.ts             # Shared utilities
  constants.ts        # VERSION and other constants
  particles/          # Bedrock particle core shared by plugin and headless: design schema, presets, builder, validator, pack planner
  sessions.ts         # Session management
ui/
  index.ts            # Panel UI
  settings.ts         # Settings registration
  statusBar.ts        # Status bar UI
macros/
  readPrompt.ts       # Build-time macro for embedding prompt files
build/
  index.ts            # Bun build script with Blockbench compatibility shims
  utils.ts            # Build utilities and logging (log.info, log.step, etc.)
  plugins.ts          # Bun plugins (text loader, Blockbench compatibility shims)
  docs.ts             # Documentation generator (Zod → JSON Schema → HTML)
  docs-manifest.ts    # Aggregates all tool/prompt/resource specs for doc generation
headless/             # Standalone Bun MCP server that edits .bbmodel files without Blockbench
  index.ts            # stdio CLI entry (--root sandbox, --bb-render)
  server.ts           # Registers every bbmodel_* tool
  document/           # Zod .bbmodel schema, 4.x<->5.0 conversion, store (sandbox, lock, revisions)
  geometry/           # ZYX transforms, world bounds, box UV, animation pose sampler
  gates/              # Geometry/animation validation gates + defect injectors (self-test)
  formats/            # Codecs ported from Blockbench: Bedrock .geo.json, Java block/item (java-block*), modded entity Java; rules.ts = per-format capabilities + checkElements
  mesh/               # Pure mesh library: Add Mesh primitives, editing (merge, extrude, loop cut, subdivide), Auto UV (ports of Blockbench)
  edit/operations.ts  # Pure batch edit operations used by bbmodel_edit (particle ops in edit/particle-operations.ts, mesh ops in edit/mesh-operations.ts, format guard in edit/format-guard.ts)
  render/             # Render bridge (bb-render.ts spawns Node) + runtime.ts (installs/bundles the engine on first use)
    engine/           # Node-run still renderer, a trimmed bb-render port: three, three-blockbench, Dawn; own png codec
  package.json        # Dependencies of render/engine only; installed into a cache folder, never the plugin's node_modules
  app/                # Web-app loaddata links (tiers + launcher pages) and desktop app launcher
  tools/              # Tool definitions by domain
docs/
  api.json            # Generated: machine-readable API documentation
  index.html          # Generated: styled single-page documentation site
  style.css           # Tailwind CSS source for docs
```

### Key Patterns

**Tool Registration**: Each tool file in `server/tools/` follows a two-part pattern:

1. Export the Zod parameter schema and a `toolDocs: IToolSpec[]` array at module level (no Blockbench globals allowed here):
```ts
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";

export const exampleParameters = z.object({
  name: z.string().describe("Name to greet."),
});

export const exampleToolDocs: IToolSpec[] = [
  {
    name: "example",
    description: "Does something",
    annotations: { title: "Example" },
    parameters: exampleParameters,
    status: "stable",
  },
];
```

2. Register inside a function, spreading from the spec:
```ts
export function registerExampleTools() {
  createTool(exampleToolDocs[0].name, {
    ...exampleToolDocs[0],
    async execute({ name }) {
      // Blockbench globals safe inside execute()
      return `Hello, ${name}!`;
    },
  }, exampleToolDocs[0].status);
}
```

After adding a tool: import the `toolDocs` in `build/docs-manifest.ts`, add to `toolManifest`, and run `bun run docs`.

**Critical**: Never use Blockbench runtime globals (`BarItems`, `Formats`, `Plugins`, etc.) in schema construction. The doc generator imports schemas outside Blockbench. Use `z.string().describe(...)` and validate at runtime in `execute()`.

**Prompt Registration**: Use `createPrompt()` from `lib/factories.ts` with optional argument completion.

**Resources**: Use `createResource()` from `lib/factories.ts` in `server/resources.ts`.

**Path Alias**: Use `@/*` for imports (e.g., `@/lib/factories`).

**Documentation Generation**: Run `bun run docs` to regenerate `docs/api.json` and `docs/index.html` from Zod schemas. The doc system uses `build/docs-manifest.ts` (imports tool schemas, defines prompt/resource specs inline) and `build/docs.ts` (converts via `zod-to-json-schema`, renders HTML with Tailwind).

**Headless package**: `headless/` must never touch Blockbench globals. It may import pure `lib/` modules (`block-grid`, `geckolib-validate`, `constants`, `ai-disclosure` constants). Its tools use `defineTool()` from `headless/tool.ts`, not `createTool()`. Keep ports of Blockbench logic (box UV, Molang inversion, legacy conversion, Bedrock compile) faithful and cite the source function. Rendering goes through `render/engine` in a Node child process because Bun cannot load Dawn. The engine's packages live in `headless/package.json` and are installed lazily by `render/runtime.ts` into `BB_RENDER_HOME` (default per-user cache), then the engine is bundled with `Bun.build` into `cli.mjs` there, because Node will not strip types from files under `node_modules` (where `npx` unpacks this repo). `render/engine` is excluded from the root tsconfig; keep it free of `@/` imports and Bun APIs, and keep it pixel-identical to bb-render when porting fixes. Write tools return a `web_app` field built by `headless/app/web-link.ts`; its encoding follows Blockbench's parser in `js/web.ts` (one `decodeURIComponent`, split on `&`, first `=`), so keep `&` and line separators out of `loaddata` and keep `app/web-link.test.ts`'s parser replica in sync if Blockbench changes it. Share `web_app` links with the user in replies.

## Code Style

- TypeScript strict mode, ESNext modules
- Use `const`/`let`, never `var`; use `async/await` with `try/catch`
- Prefer early returns over nested `if/else`
- Never use `any`; use `unknown` with explicit narrowing
- Use `interface` for object shapes, always prefixed with `I` (e.g. `IToolSpec`); use `type` for unions, tuples, and `z.infer` aliases
- Wrap Blockbench undo transactions with `runUndoableEdit()` / `cancelUndoEdit()` from `lib/undo.ts`
- 2-space indentation
- Zod for validation; store reusable schemas in `lib/zodObjects.ts`
- Blockbench types are incomplete; use `// @ts-ignore` when necessary

## Blockbench Integration Notes

- Blockbench v5.0+ restricts Node modules; the build script injects shims that use `requireNativeModule()` for permission handling
- Reference Blockbench source (JannisX11/blockbench) for missing types
- Avoid blocking UI during tool execution
- Default server: `http://localhost:3000/bb-mcp` (configurable in Settings > General)

## Testing

No automated tests yet. Manual verification:
1. Build: `bun run build`
2. Docs: `bun run docs` (verify tool count matches expectations)
3. Load plugin in Blockbench
4. Use MCP Inspector to test tools/resources
5. Verify UI renders in light/dark themes

## Commits

Use conventional prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`. Be specific (e.g., `feat: add mesh selection tools`).

## Benchmark results

`benchmarks/results/` holds local, git-ignored benchmark evidence (large traces,
`.bbmodel` snapshots and images). Do not search, read or summarize it unless the
user points to a specific file there, and never stage, commit or force-add it.
