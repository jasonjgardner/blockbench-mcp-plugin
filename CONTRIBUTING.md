# Contributing to Blockbench MCP Plugin

Thank you for improving the Blockbench MCP plugin. This project uses TypeScript and Bun. Please keep changes focused, documented, and easy to verify inside Blockbench.

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/jasonjgardner/blockbench-mcp-plugin)

## Prerequisites
- Bun installed: https://bun.sh/
- Blockbench (desktop) for local testing.

## Setup & Development
```sh
bun install                # install deps
bun run dev                # build once with sourcemaps
bun run dev:watch          # rebuild on change (watch mode)
bun run build              # minified production build to dist/mcp.js
```

For MCP Inspector (optional):
```sh
bunx @modelcontextprotocol/inspector
```
Default server transport (when plugin is loaded): `http://localhost:3000/bb-mcp`.

Local testing in Blockbench: File → Plugins → Load Plugin from File → select `dist/mcp.js`.

## Project Structure
- `index.ts`: Plugin entry; registers server, UI, settings.
- `server/`: MCP server implementation.
  - `server.ts`: McpServer singleton (official MCP SDK).
  - `tools.ts`: Tool module aggregator importing domain-specific tools.
  - `tools/`: Tool implementations by domain (animation, camera, cubes, element, import, mesh, paint, project, texture, ui, uv).
  - `resources.ts`: MCP resource definitions.
  - `prompts.ts`: MCP prompts with argument schemas.
  - `net.ts`: HTTP server and transport handling.
- `ui/`: Panel, settings, and status bar UI.
- `lib/`: Shared utilities, factories (`createTool`, `createResource`, `createPrompt`), and Zod schemas.
- `macros/`: Build-time macros (e.g., prompt embedding).
- `dist/`: Build outputs (`mcp.js`, maps, copied assets).

## Adding Tools
Use `createTool()` from `lib/factories.ts`. Tools are organized by domain in `server/tools/` (e.g., `animation.ts`, `paint.ts`, `mesh.ts`). Each domain file exports a registration function that is called from `server/tools.ts`.

Example tool in a domain file (e.g., `server/tools/example.ts`):
```ts
import { z } from "zod";
import { createTool } from "@/lib/factories";

export function registerExampleTools() {
  createTool("example", {
    description: "Does something useful",
    annotations: { title: "Example" },
    parameters: z.object({ name: z.string() }),
    async execute({ name }) {
      return `Hello, ${name}!`;
    },
  });
}
```
Then import and call the registration function in `server/tools.ts`.

- Naming: Tools are registered with the name you provide (no automatic prefix).
- Validate inputs with `zod`. Avoid blocking UI during execution.

### From another Blockbench plugin
Other plugins register tools at runtime through the `MCP` global and the `MCP_QUEUE` bootstrap array; see the README section "Extending from another plugin" for the author-facing guide. The contract is `lib/mcp-api.d.ts` (copied to `dist/blockbench-mcp-api.d.ts` and published with releases), the runtime is `lib/plugin-api.ts`, and `lib/plugin-api.test.ts` covers load order, ownership cleanup, live-session propagation and validation. Keep the `.d.ts` and the runtime in step: `lib/plugin-api.ts` imports its types from the `.d.ts`, so a drift fails `tsc`.

## Adding Resources
Use `createResource()` from `lib/factories.ts` in `server/resources.ts`:
```ts
import { createResource } from "@/lib/factories";

createResource("example", {
  uriTemplate: "example://{id}",
  title: "Example Resource",
  description: "Description of the resource",
  async listCallback() {
    // Return list of available resources
    return { resources: [{ uri: "example://1", name: "Item 1" }] };
  },
  async readCallback(uri, { id }) {
    // Return resource content
    return { contents: [{ uri: uri.href, text: JSON.stringify({ id }) }] };
  },
});
```
See existing `projects`, `nodes`, and `textures` examples in `server/resources.ts`.

## Adding Prompts
Use `createPrompt()` from `lib/factories.ts` in `server/prompts.ts`:
```ts
import { z } from "zod";
import { createPrompt } from "@/lib/factories";

createPrompt("example_prompt", {
  description: "Description of the prompt",
  argsSchema: z.object({
    option: z.enum(["a", "b"]).optional(),
  }),
  async generate({ option }) {
    return {
      messages: [{ role: "user", content: { type: "text", text: `Selected: ${option}` } }],
    };
  },
});
```
See `server/prompts.ts` for examples using the `readPrompt` macro to embed prompt text files.

## Style & Commits
- TypeScript strict mode; ESNext modules; use the `@/*` path alias.
- 2-space indentation; explicit return types where reasonable.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`. Be specific.

## Pull Requests
- Describe scope and intent, link related issues.
- Add repro and verification steps; include screenshots/GIFs for UI changes.
- Call out new tools, resources, settings, or breaking changes.

## Manual Verification Checklist
- Build: `bun run build` (or `bun run dev`) and confirm `dist/mcp.js` updates.
- Load: In Blockbench → File → Plugins → Load Plugin from File → pick `dist/mcp.js`.
- Settings: Confirm MCP port/endpoint under Settings → General (defaults `3000` and `/bb-mcp`).
- Server: Open the MCP panel; ensure server shows connected when a client attaches.
- Tools: Verify new tool appears with a readable title. Using MCP Inspector, call the tool with a small sample payload; confirm no errors and expected side effects (and Undo works when applicable).
- Resources: In Inspector, resolve a sample URI (e.g., `nodes://<id>` or `textures://<name>`); confirm autocompletion and returned data.
- Prompts: Load the prompt; check argument autocompletion and that `load` returns content without errors.
- UI: Sanity check layout in light/dark themes; verify tool status badges and descriptions render and truncate gracefully.

## Required Desktop Checks Before Releases

Tag deployments require a passing local desktop record in `releases/desktop-smoke.json`.

1. Finish the source changes and set the intended version in `package.json`.
2. Run `bun install --frozen-lockfile` and `bun run build`.
3. Load or reload this repository's `dist/mcp.js` in Blockbench desktop. Reconnect existing MCP clients after reloading.
4. Run `bun run release:smoke`. For a custom server address, append its URL, for example `bun run release:smoke http://localhost:3100/bb-mcp`.
5. Review the passing record and outputs in `artifacts/`. Commit the record together with the tested source, and make that the last commit: any later change, even to a comment, moves the source fingerprint and CI rejects the tag.
6. Run `bun run release:tag` (add `--push` to push it). It runs the same verification as CI against the committed tree, refuses a dirty checkout or an existing tag, and only then creates `v<version>`.

The command checks the loaded plugin's source build ID, production build mode and desktop environment, runs Bun regression tests and the animation, action, PBR, MCP identity, and read-only inspection suites, then writes the record. Animation checks exercise real rig rotation, playback, keyframe data, and undo/redo. The live suites create separate temporary projects and leave the MCP identity project open. Save other work before testing. A failed repeat replaces the prior passing record with a failed result.

The tag workflow runs regression tests and rejects missing, failed, incomplete, or stale desktop evidence before deployment. Changes to runtime source, assets, dependencies, build scripts, tests, or the deployment workflow require a rebuild, reload, and fresh run. The fingerprint normalizes checkout line endings; it excludes generated docs, the timestamped prompt manifest, and the receipt itself. Prompt sources and the manifest generator remain covered.

The record includes the tested local bundle hash, Bun version, Blockbench version/platform, timestamps, and individual assertions. CI verifies the source fingerprint and version tag; it rebuilds the release and does not require a byte-identical bundle across platforms. This is a reviewable maintainer test record, not a signed desktop attestation. Generated models, screenshots, and raw logs remain ignored under `artifacts/`; the small release record is tracked in Git.
