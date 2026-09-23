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
import { ModelStore } from "./document/store";
import { BbRenderer, locateBbRender } from "./render/bb-render";
import { createHeadlessServer, HEADLESS_SERVER_NAME, HEADLESS_TOOLS } from "./server";

const HELP = `${HEADLESS_SERVER_NAME} ${VERSION}

Edits, validates, converts and renders Blockbench .bbmodel files without Blockbench.
Speaks MCP over stdio.

Options:
  --root <dir>              Workspace directory the server may read and write (required, repeatable)
  --bb-render <cli.js>      Path to bb-render's dist/cli.js (default: $BB_RENDER_CLI, then the sibling
                            blockbench-mcp-project checkout)
  --node <path>             Node 23.6+ executable used to run bb-render (default: node)
  --render-concurrency <n>  Renders allowed at once (default: 2)
  --render-timeout <ms>     Per-render timeout (default: 120000)
  --scratch <dir>           Where renders go when no output path is given (default: OS temp)
  --no-ai-disclosure        Do not stamp ai_used / ai_agents on written models
  --list-tools              Print tool names and exit
  --help                    Show this help
`;

const { values } = parseArgs({
  options: {
    root: { type: "string", multiple: true },
    "bb-render": { type: "string" },
    node: { type: "string" },
    "render-concurrency": { type: "string" },
    "render-timeout": { type: "string" },
    scratch: { type: "string" },
    "no-ai-disclosure": { type: "boolean", default: false },
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
  // Source runs from headless/, the bundle from dist/headless/.
  const cli = await locateBbRender(values["bb-render"], [resolve(import.meta.dir, ".."), resolve(import.meta.dir, "..", "..")]);
  const renderer = new BbRenderer({
    cli,
    node: values.node ?? "node",
    concurrency: positiveInt(values["render-concurrency"], 2, "--render-concurrency"),
    timeoutMs: positiveInt(values["render-timeout"], 120_000, "--render-timeout"),
  });
  const store = new ModelStore({ roots });
  const scratchDir = values.scratch ? resolve(values.scratch) : join(tmpdir(), HEADLESS_SERVER_NAME);
  const server = createHeadlessServer((mcp) => ({
    store,
    renderer,
    scratchDir,
    aiDisclosure: !values["no-ai-disclosure"],
    clientName: () => mcp.server.getClientVersion()?.name ?? UNKNOWN_AGENT,
  }));
  await server.connect(new StdioServerTransport());
  process.stderr.write(`${HEADLESS_SERVER_NAME} ${VERSION} ready. Roots: ${roots.join(", ")}. bb-render: ${cli ?? "not found (render tools will report how to install it)"}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
