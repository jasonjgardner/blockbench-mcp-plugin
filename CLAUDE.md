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
bunx @modelcontextprotocol/inspector  # Test MCP tools locally
```

Output goes to `dist/mcp.js`. Load in Blockbench via File > Plugins > Load Plugin from File.

## Architecture

```
index.ts              # Plugin entry - registers server, UI, settings
server/
  server.ts           # McpServer singleton (official MCP SDK)
  tools.ts            # Tool module imports aggregator
  tools/              # Tool implementations by domain (animation, camera, cubes, element, import, mesh, paint, project, texture, ui, uv)
  resources.ts        # MCP resource definitions
  prompts.ts          # MCP prompts with argument completion
  net.ts              # HTTP server and transport handling
lib/
  factories.ts        # createTool(), createPrompt(), and createResource() helpers
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
build.ts              # Bun build script with Blockbench compatibility shims
```

### Key Patterns

**Tool Registration**: Use `createTool()` from `lib/factories.ts`. Tools are registered with the MCP server using the name provided:
```ts
import { z } from "zod";
import { createTool } from "@/lib/factories";

createTool("example", {
  description: "Does something",
  annotations: { title: "Example" },
  parameters: z.object({ name: z.string() }),
  async execute({ name }) {
    return `Hello, ${name}!`;
  },
});
```

**Prompt Registration**: Use `createPrompt()` from `lib/factories.ts` with optional argument completion.

**Resources**: Use `createResource()` from `lib/factories.ts` in `server/resources.ts`.

**Path Alias**: Use `@/*` for imports (e.g., `@/lib/factories`).

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
2. Load plugin in Blockbench
3. Use MCP Inspector to test tools/resources
4. Verify UI renders in light/dark themes

## Commits

Use conventional prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`. Be specific (e.g., `feat: add mesh selection tools`).
