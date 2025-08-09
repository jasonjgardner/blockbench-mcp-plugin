# Repository Guidelines

## Project Structure & Module Organization
- `index.ts`: Blockbench plugin entry (registers MCP server and UI).
- `server/`: FastMCP server glue (`server.ts`), `tools/`, `resources.ts`, `prompts.ts`.
- `ui/`: Panel UI and settings (`index.ts`, `settings.ts`).
- `lib/`: Shared utilities and factories (`constants.ts`, `factories.ts`, `util.ts`).
- `prompts/` and `macros/`: Prompt templates and helpers.
- `dist/`: Build output (`mcp.js`, maps, copied assets like `icon.svg`, `about.md`).
- `docs/`: Supplemental docs (e.g., `tools.md`).

## Build, Test, and Development Commands
- `bun install`: Install dependencies.
- `bun run dev`: Build once with sourcemaps.
- `bun run dev:watch`: Rebuild on change (watch mode).
- `bun run compile`: Minified production build to `dist/mcp.js`.
- `bun run ./build.ts --clean`: Remove `dist/` before a fresh build.
- `bunx @modelcontextprotocol/inspector`: Launch MCP Inspector for local testing.

## Coding Style & Naming Conventions
- Language: TypeScript (strict), ESNext modules, CJS output for the plugin.
- Paths: Use alias `@/*` (see `tsconfig.json`).
- Indentation: 2 spaces; prefer explicit return types and narrow types.
- Tools: Name with `blockbench_<action>` (UI strips the prefix for display).
- Keep UI text concise; avoid blocking calls in plugin lifecycle hooks.

## Testing Guidelines
- Automated tests are not set up yet. For changes, provide manual verification steps.
- Validate builds with Blockbench by loading `dist/mcp.js` and exercising changed tools/resources.
- When adding tests, prefer Bun’s test runner or Vitest; co-locate near source or use `tests/`.

## Commit & Pull Request Guidelines
- Commits: Use conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`). Avoid vague "update"; be specific (e.g., `feat: add mesh selection tools`).
- PRs: Include scope/summary, linked issues, screenshots/GIFs for UI changes, and steps to reproduce/test. Note any new tools, resources, settings, or breaking changes.

## Security & Configuration Tips
- Server config lives in Blockbench Settings: MCP port and endpoint (defaults `:3000/bb-mcp`).
- Do not commit secrets. Keep network calls behind tools; validate all inputs (use `zod`).
- Keep bundle lean: add only necessary deps; prefer tree-shakeable utilities.
