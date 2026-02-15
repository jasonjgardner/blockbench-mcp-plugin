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
  factories.ts        # createTool(), createPrompt(), createResource(), ToolSpec/PromptSpec/ResourceSpec
  zodObjects.ts       # Reusable Zod schemas
  util.ts             # Shared utilities
  constants.ts        # VERSION and other constants
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
docs/
  api.json            # Generated: machine-readable API documentation
  index.html          # Generated: styled single-page documentation site
  style.css           # Tailwind CSS source for docs
```

### Key Patterns

**Tool Registration**: Each tool file in `server/tools/` follows a two-part pattern:

1. Export the Zod parameter schema and a `toolDocs: ToolSpec[]` array at module level (no Blockbench globals allowed here):
```ts
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";

export const exampleParameters = z.object({
  name: z.string().describe("Name to greet."),
});

export const exampleToolDocs: ToolSpec[] = [
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

## Code Style

- TypeScript strict mode, ESNext modules
- Use `const`/`let`, never `var`; use `async/await` with `try/catch`
- Prefer early returns over nested `if/else`
- Never use `any`; prefer interfaces over types
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
