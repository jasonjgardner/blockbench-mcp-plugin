# Contributing to Blockbench MCP Plugin

Thank you for improving the Blockbench MCP plugin. This project uses TypeScript and Bun. Please keep changes focused, documented, and easy to verify inside Blockbench.

## Prerequisites
- Bun installed: https://bun.sh/
- Blockbench (desktop) for local testing.

## Setup & Development
```sh
bun install                # install deps
bun run dev                # build once with sourcemaps
bun run dev:watch          # rebuild on change (watch mode)
bun run compile            # minified production build to dist/mcp.js
bun run ./build.ts --clean # remove dist/ for a fresh build
```

For MCP Inspector (optional):
```sh
bunx @modelcontextprotocol/inspector
```
Default server transport (when plugin is loaded): `http://localhost:3000/bb-mcp`.

Local testing in Blockbench: File → Plugins → Load Plugin from File → select `dist/mcp.js`.

## Project Structure
- `index.ts`: Plugin entry; registers server, UI, settings.
- `server/`: FastMCP integration (`server.ts`), tools, resources, prompts.
- `ui/`: Panel and settings UI.
- `lib/`: Shared utilities and factories.
- `dist/`: Build outputs (`mcp.js`, maps, copied assets).

## Adding Tools
Use the factory in `lib/factories.ts`. Tools are automatically registered with the server and surfaced in the UI.
```ts
// server/tools.ts
import { z } from "zod";
import { createTool } from "@/lib/factories";

createTool("example", {
  description: "Does something useful",
  annotations: { title: "Example" },
  parameters: z.object({ name: z.string() }),
  async execute({ name }) {
    return `Hello, ${name}!`;
  },
});
```
- Naming: Tools are prefixed automatically as `blockbench_<suffix>`; the UI hides this prefix.
- Validate inputs with `zod`. Avoid blocking UI during execution.

## Adding Resources
There is no resource factory; add templates directly in `server/resources.ts` and register via `server.addResourceTemplate(...)`. See existing `nodes`, `textures`, and `reference_model` examples.

## Adding Prompts
Use `createPrompt` from `lib/factories.ts`. See `server/prompts.ts` for a complete example including `arguments` autocompletion and `load` logic.

## Style & Commits
- TypeScript strict mode; ESNext modules; use the `@/*` path alias.
- 2-space indentation; explicit return types where reasonable.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`. Be specific.

## Pull Requests
- Describe scope and intent, link related issues.
- Add repro and verification steps; include screenshots/GIFs for UI changes.
- Call out new tools, resources, settings, or breaking changes.

## Manual Verification Checklist
- Build: `bun run compile` (or `bun run dev`) and confirm `dist/mcp.js` updates.
- Load: In Blockbench → File → Plugins → Load Plugin from File → pick `dist/mcp.js`.
- Settings: Confirm MCP port/endpoint under Settings → General (defaults `3000` and `/bb-mcp`).
- Server: Open the MCP panel; ensure server shows connected when a client attaches.
- Tools: Verify new tool appears with a readable title. Using MCP Inspector, call the tool with a small sample payload; confirm no errors and expected side effects (and Undo works when applicable).
- Resources: In Inspector, resolve a sample URI (e.g., `nodes://<id>` or `textures://<name>`); confirm autocompletion and returned data.
- Prompts: Load the prompt; check argument autocompletion and that `load` returns content without errors.
- UI: Sanity check layout in light/dark themes; verify tool status badges and descriptions render and truncate gracefully.
