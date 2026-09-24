#!/usr/bin/env node
/**
 * npx launcher for the headless Blockbench MCP server.
 *
 * The server uses Bun APIs, so this Node shim finds a Bun executable (the `bun`
 * npm dependency first, then PATH) and runs headless/index.ts with it, forwarding
 * argv and stdio untouched so the MCP stdio transport works.
 *
 * npx -y github:jasonjgardner/blockbench-mcp-plugin --root "<folder>"
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "headless", "index.ts");

/** Locates the Bun binary shipped by the `bun` npm package, or falls back to PATH. */
function findBun() {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("bun/package.json");
    const bin = require(pkgPath).bin;
    const rel = typeof bin === "string" ? bin : bin?.bun;
    return rel ? join(dirname(pkgPath), rel) : "bun";
  } catch {
    return "bun";
  }
}

const bun = findBun();
const isJs = /\.(c|m)?js$/.test(bun);
const child = spawn(isJs ? process.execPath : bun, [...(isJs ? [bun] : []), entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});

child.on("error", (err) => {
  console.error(`Could not start Bun (${bun}): ${err.message}. Install Bun from https://bun.sh.`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
