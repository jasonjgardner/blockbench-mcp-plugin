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
  tools/              # Tool implementations by domain (animation, cubes, mesh, paint, etc.)
  resources.ts        # MCP resource templates
  prompts.ts          # MCP prompts with argument completion
lib/
  factories.ts        # createTool() and createPrompt() helpers
  zodObjects.ts       # Reusable Zod schemas
  util.ts             # Shared utilities
  constants.ts        # VERSION and other constants
ui/
  index.ts            # Panel UI
  settings.ts         # Settings registration
build.ts              # Bun build script with Blockbench compatibility shims
```

### Key Patterns

**Tool Registration**: Use `createTool()` from `lib/factories.ts`. Tools are auto-prefixed with `blockbench_` and registered with the MCP server:
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

**Resources**: Add directly in `server/resources.ts` using `server.registerResource()`.

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
