#!/usr/bin/env bun
/**
 * CLI entry for the headless Blockbench MCP server (stdio transport).
 *
 * ```sh
 * bun run headless/index.ts --root ./models
 * ```
 *
 * Each MCP client launches its own process, which is what lets several agents
 * work at once: nothing here touches the Blockbench app.
 *
 * @module
 */

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { UNKNOWN_AGENT } from "@/lib/ai-disclosure";
import { VERSION } from "@/lib/constants";
import { DEFAULT_DESKTOP_MCP_URL } from "./app/desktop";
import { DEFAULT_BROWSER_MAX, DEFAULT_INLINE_MAX, DEFAULT_WEB_APP_URL, normalizeWebAppUrl } from "./app/web-link";
import { ModelStore } from "./document/store";
import { BbRenderer } from "./render/bb-render";
import { createHeadlessServer, HEADLESS_SERVER_NAME, HEADLESS_TOOLS } from "./server";

const HELP = `${HEADLESS_SERVER_NAME} ${VERSION}

Edits, validates, converts and renders Blockbench .bbmodel files without Blockbench.
Speaks MCP over stdio.

Options:
  --root <dir>              Workspace directory the server may read and write (required, repeatable)
  --render-home <dir>       Where the render engine's Node packages are installed on first render
                            (default: $BB_RENDER_HOME, then the per-user cache folder)
  --bb-render <cli.js>      Use an external bb-render dist/cli.js instead of the built-in engine
                            (default: $BB_RENDER_CLI)
  --node <path>             Node 23.6+ executable used to run the renderer (default: node)
  --render-concurrency <n>  Renders allowed at once (default: 2)
  --render-timeout <ms>     Per-render timeout (default: 120000)
  --scratch <dir>           Where renders go when no output path is given (default: OS temp)
  --no-ai-disclosure        Do not stamp ai_used / ai_agents on written models
  --blockbench <path>       Blockbench desktop executable (or .app) for blockbench_launch (default:
                            $BLOCKBENCH_PATH, blockbench on PATH, then the standard install folders)
  --blockbench-mcp-url <u>  Desktop plugin MCP endpoint polled by blockbench_launch (default:
                            http://localhost:3000/bb-mcp)
  --web-app-url <url>       Blockbench web app for web_app links (default: https://web.blockbench.net/)
  --web-url-inline-max <n>  Longest web-app URL returned inline, in characters (default: 8000)
  --web-url-max <n>         Longest URL a web-app launcher page is written for (default: 2000000)
  --no-web-links            Leave web_app links out of write results (bbmodel_web_url still works)
  --list-tools              Print tool names and exit
  --help                    Show this help
`;

const { values } = parseArgs({
  options: {
    root: { type: "string", multiple: true },
    "bb-render": { type: "string" },
    "render-home": { type: "string" },
    node: { type: "string" },
    "render-concurrency": { type: "string" },
    "render-timeout": { type: "string" },
    scratch: { type: "string" },
    "no-ai-disclosure": { type: "boolean", default: false },
    blockbench: { type: "string" },
    "blockbench-mcp-url": { type: "string" },
    "web-app-url": { type: "string" },
    "web-url-inline-max": { type: "string" },
    "web-url-max": { type: "string" },
    "no-web-links": { type: "boolean", default: false },
    "list-tools": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

const positiveInt = (raw: string | undefined, fallback: number, flag: string): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  throw new Error(`${flag} must be a positive integer, got "${raw}".`);
};

/** Starts the stdio server. */
async function main(): Promise<void> {
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values["list-tools"]) {
    process.stdout.write(`${HEADLESS_TOOLS.map((tool) => `${tool.name}${tool.readOnly ? "" : " (writes)"}`).join("\n")}\n`);
    return;
  }
  // MCP clients often start servers in the home directory, so the sandbox is never implied.
  if (!values.root || values.root.length === 0) throw new Error("Pass --root <dir> for each folder the server may read and write. See --help.");
  const roots = values.root.map((root) => resolve(root));
  const cli = values["bb-render"] ?? Bun.env.BB_RENDER_CLI;
  const renderer = new BbRenderer({
    cli,
    node: values.node ?? "node",
    concurrency: positiveInt(values["render-concurrency"], 2, "--render-concurrency"),
    timeoutMs: positiveInt(values["render-timeout"], 120_000, "--render-timeout"),
    home: values["render-home"] ? resolve(values["render-home"]) : undefined,
    log: (message) => process.stderr.write(`${message}
`),
  });
  const store = new ModelStore({ roots });
  const scratchDir = values.scratch ? resolve(values.scratch) : join(tmpdir(), HEADLESS_SERVER_NAME);
  const server = createHeadlessServer((mcp) => ({
    store,
    renderer,
    scratchDir,
    aiDisclosure: !values["no-ai-disclosure"],
    clientName: () => mcp.server.getClientVersion()?.name ?? UNKNOWN_AGENT,
    webApp: {
      enabled: !values["no-web-links"],
      baseUrl: normalizeWebAppUrl(values["web-app-url"] ?? DEFAULT_WEB_APP_URL),
      inlineMax: positiveInt(values["web-url-inline-max"], DEFAULT_INLINE_MAX, "--web-url-inline-max"),
      browserMax: positiveInt(values["web-url-max"], DEFAULT_BROWSER_MAX, "--web-url-max"),
      launcherDir: join(scratchDir, "web-app"),
    },
    desktop: { executable: values.blockbench, mcpUrl: values["blockbench-mcp-url"] ?? DEFAULT_DESKTOP_MCP_URL },
  }));
  await server.connect(new StdioServerTransport());
  process.stderr.write(`${HEADLESS_SERVER_NAME} ${VERSION} ready. Roots: ${roots.join(", ")}. Renderer: ${cli ?? "built-in engine (installs its packages on first render)"}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
