# Repository Guidelines

## Project Structure & Module Organization
- `index.ts`: Blockbench plugin entry (registers MCP server and UI).
- `server/`: MCP server glue (`server.ts`), `tools/`, `resources.ts`, `prompts.ts`.
- `ui/`: Panel UI and settings (`index.ts`, `settings.ts`).
- `lib/`: Shared utilities and factories (`constants.ts`, `factories.ts`, `util.ts`, `zodObjects.ts`).
- `prompts/` and `macros/`: Prompt templates and helpers.
- `dist/`: Build output (`mcp.js`, maps, copied assets like `icon.svg`, `about.md`).
- `docs/`: Auto-generated documentation (`api.json`, `index.html`, `style.css`).
- `build/`: Build scripts (`index.ts`, `utils.ts`, `plugins.ts`, `docs.ts`, `docs-manifest.ts`).

## Build, Test, and Development Commands
- `bun install`: Install dependencies.
- `bun run dev`: Build once with sourcemaps.
- `bun run dev:watch`: Rebuild on change (watch mode).
- `bun run build`: Minified production build to `dist/mcp.js`.
- `bun run ./build.ts --clean`: Remove `dist/` before a fresh build.
- `bun run docs`: Generate API documentation from Zod schemas to `docs/`.
- `bun run docs:serve`: Serve the generated docs locally with Tailwind processing.
- `bunx @modelcontextprotocol/inspector`: Launch MCP Inspector for local testing.

## Adding New Tools

Every tool file in `server/tools/` follows a two-part pattern:

1. **Export parameter schemas and a `toolDocs` array** at module level (no Blockbench globals):
```ts
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";

export const myToolParameters = z.object({
  name: z.string().describe("Name of the thing."),
});

export const myToolDocs: ToolSpec[] = [
  {
    name: "my_tool",
    description: "Does something useful.",
    annotations: { title: "My Tool", destructiveHint: true },
    parameters: myToolParameters,
    status: "stable",
  },
];
```

2. **Register with `createTool()`** inside a `registerXxxTools()` function, spreading from the spec:
```ts
export function registerMyTools() {
  createTool(myToolDocs[0].name, {
    ...myToolDocs[0],
    async execute({ name }) {
      // Blockbench globals (Undo, Canvas, etc.) are safe here
      return `Hello, ${name}!`;
    },
  }, myToolDocs[0].status);
}
```

3. **Update the docs manifest** in `build/docs-manifest.ts`:
   - Import the `toolDocs` array from your tool file.
   - Add it to `toolManifest` with the appropriate category.

4. **Register in `server/tools.ts`**: Import and call your `registerXxxTools()` function.

5. **Regenerate docs**: Run `bun run docs` to update `docs/api.json` and `docs/index.html`.

### Critical Rule: No Blockbench Globals in Schemas

Parameter schemas are imported at build time by the doc generator, which runs outside Blockbench. **Never use Blockbench runtime globals** (e.g., `BarItems`, `Formats`, `Plugins`) in schema construction. Use `z.string().describe("...")` instead of dynamic enums, and do runtime validation inside `execute()`.

## Documentation System

Documentation is auto-generated from Zod schemas at build time:

- **`build/docs-manifest.ts`**: Imports all `toolDocs` arrays from tool files plus inline prompt/resource specs. This is the single source of truth for what appears in the docs.
- **`build/docs.ts`**: Reads the manifest, converts Zod schemas to JSON Schema via `zod-to-json-schema`, and outputs `docs/api.json` (machine-readable) and `docs/index.html` (Tailwind-styled page).
- **`lib/factories.ts`**: Defines `ToolSpec`, `PromptSpec`, and `ResourceSpec` interfaces used by both tool files and the manifest.

Prompt and resource specs are defined **inline in the manifest** (not imported from their source files) because `server/prompts.ts` uses Bun macros and `server/resources.ts` accesses Blockbench globals at module level.

## Coding Style & Naming Conventions
- Language: TypeScript (strict), ESNext modules, CJS output for the plugin.
- Paths: Use alias `@/*` (see `tsconfig.json`).
- Indentation: 2 spaces; prefer explicit return types and narrow types.
- Keep UI text concise; avoid blocking calls in plugin lifecycle hooks.
- Schema naming: `{camelCaseToolName}Parameters` (e.g., `placeCubeParameters`).
- Docs array naming: `{domainName}ToolDocs` (e.g., `cubeToolDocs`).

## Testing Guidelines
- Automated tests are not set up yet. For changes, provide manual verification steps.
- Validate builds with Blockbench by loading `dist/mcp.js` and exercising changed tools/resources.
- When adding tests, prefer Bun's test runner or Vitest; co-locate near source or use `tests/`.

## Commit & Pull Request Guidelines
- Commits: Use conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`). Avoid vague "update"; be specific (e.g., `feat: add mesh selection tools`).
- PRs: Include scope/summary, linked issues, screenshots/GIFs for UI changes, and steps to reproduce/test. Note any new tools, resources, settings, or breaking changes.

## Security & Configuration Tips
- Server config lives in Blockbench Settings: MCP port and endpoint (defaults `:3000/bb-mcp`).
- Do not commit secrets. Keep network calls behind tools; validate all inputs (use `zod`).
- Keep bundle lean: add only necessary deps; prefer tree-shakeable utilities.
