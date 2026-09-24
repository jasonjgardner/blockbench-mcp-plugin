/**
 * Live smoke test for the headless server: launches it over stdio exactly as an
 * MCP client would, builds and validates a model, and renders it with the real
 * built-in render engine (needs Node 23.6+, npm and a WebGPU-capable GPU; the first
 * run installs the engine's packages into the per-user cache folder).
 *
 * ```sh
 * bun run test:headless:live            # writes to a temporary folder
 * bun run test:headless:live ./out      # keeps the renders in ./out
 * ```
 *
 * @module
 */

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { creatureModel } from "./test-fixtures";

const root = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), "bb-headless-live-"));
await mkdir(root, { recursive: true });
await Bun.write(join(root, "creature.bbmodel"), JSON.stringify(creatureModel(true), null, "\t"));

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", join(import.meta.dir, "index.ts"), "--root", root, "--scratch", join(root, "renders")],
  stderr: "inherit",
});
const client = new Client({ name: "headless-live-smoke", version: "1.0.0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const texts = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  if (result.isError) throw new Error(`${name} failed: ${texts.join("\n")}`);
  return result;
};
const images = (result: CallToolResult): number => result.content.filter((part) => part.type === "image").length;

const started = performance.now();
await call("bbmodel_validate", { file: "creature.bbmodel", self_test: true });
await call("bbmodel_validate_animations", { file: "creature.bbmodel" });
const sheet = await call("bbmodel_contact_sheet", { file: "creature.bbmodel", views: ["front", "right", "three-quarter", "top"], size: 256 });
const posed = await call("bbmodel_render", { file: "creature.bbmodel", view: "right", clip: "animation.creature.walk", time: 0.25, width: 384, height: 384 });
await client.close();

const expected = 5;
const rendered = images(sheet) + images(posed);
process.stdout.write(`Rendered ${rendered}/${expected} images in ${Math.round(performance.now() - started)} ms. Output: ${join(root, "renders")}\n`);
if (rendered !== expected) process.exit(1);
