/**
 * One-shot command-line client for the headless MCP server.
 *
 * Agents without an MCP connection to the headless server (for example
 * subagents, CI scripts, or a shell) can call any tool through a real MCP
 * session: this script starts the stdio server, calls one tool, prints the
 * result, and exits. Image content is not printed; the render tools report the
 * PNG path in their text output, so open that file to see the image.
 *
 * ```sh
 * bun run headless/call.ts --root ./models --list
 * bun run headless/call.ts --root ./models bbmodel_info '{"file":"chair.bbmodel"}'
 * bun run headless/call.ts --root ./models bbmodel_edit @ops.json
 * ```
 *
 * Exit code 1 means the tool returned an error (its message is printed).
 *
 * @module
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", multiple: true },
    "bb-render": { type: "string" },
    "render-concurrency": { type: "string" },
    list: { type: "boolean", default: false },
  },
});

/** Reads tool arguments from inline JSON, `@path/to/args.json`, or nothing. */
async function readArguments(raw: string | undefined): Promise<Record<string, unknown>> {
  if (raw === undefined) return {};
  const text = raw.startsWith("@") ? await Bun.file(raw.slice(1)).text() : raw;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Tool arguments must be a JSON object.");
  return parsed as Record<string, unknown>;
}

/** Prints text parts and a placeholder for each image part. */
function describe(result: CallToolResult): string {
  return result.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return `[image ${part.mimeType}, ${Math.round((part.data.length * 3) / 4 / 1024)} KB omitted; open the PNG path above]`;
      return `[${part.type} content omitted]`;
    })
    .join("\n");
}

async function main(): Promise<number> {
  const roots = values.root ?? [];
  if (roots.length === 0) throw new Error("Pass --root <dir> (the same workspace the server should use).");
  const serverArgs = ["run", join(import.meta.dir, "index.ts"), ...roots.flatMap((root) => ["--root", root]), ...(values["bb-render"] ? ["--bb-render", values["bb-render"]] : []), ...(values["render-concurrency"] ? ["--render-concurrency", values["render-concurrency"]] : [])];
  const client = new Client({ name: "headless-call", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "bun", args: serverArgs, stderr: "ignore" }));
  try {
    if (values.list) {
      const { tools } = await client.listTools();
      process.stdout.write(`${tools.map((tool) => `${tool.name}\n  ${tool.description ?? ""}`).join("\n")}\n`);
      return 0;
    }
    const [tool, rawArgs] = positionals;
    if (!tool) throw new Error("Usage: call.ts --root <dir> <tool> ['{json}' | @args.json]   or   call.ts --root <dir> --list");
    const result = (await client.callTool({ name: tool, arguments: await readArguments(rawArgs) }, undefined, { timeout: 600_000 })) as CallToolResult;
    process.stdout.write(`${describe(result)}\n`);
    return result.isError ? 1 : 0;
  } finally {
    await client.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
