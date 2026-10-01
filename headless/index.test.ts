import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Starts the real stdio server, with the OS temp directory pointed at `temp`. */
async function startServer(root: string, temp: string): Promise<Client> {
  const client = new Client({ name: "cli-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", join(import.meta.dir, "index.ts"), "--root", root],
    env: { TMPDIR: temp, TEMP: temp, TMP: temp },
    stderr: "ignore",
  });
  await client.connect(transport);
  return client;
}

const firstText = (result: CallToolResult): string => (result.content[0]?.type === "text" ? result.content[0].text : "");

describe("headless CLI", () => {
  let root = "";
  let temp = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-headless-cli-"));
    temp = await mkdtemp(join(tmpdir(), "bb-headless-cli-temp-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  });

  test("the scratch folder is private and made only when something is written there", async () => {
    // Nothing is created up front, so a server that is stopped, even by a signal, leaves nothing behind.
    const idle = await startServer(root, temp);
    await idle.callTool({ name: "bbmodel_create", arguments: { file: "a.bbmodel" } });
    await idle.callTool({ name: "bbmodel_info", arguments: { file: "a.bbmodel" } });
    expect(await readdir(temp)).toEqual([]);
    await idle.close();

    const writer = await startServer(root, temp);
    const linked = (await writer.callTool({ name: "bbmodel_web_url", arguments: { file: "a.bbmodel", inline_max: 200 } })) as CallToolResult;
    await writer.close();
    const launcher = (JSON.parse(firstText(linked)) as { web_app: { launcher: { path: string } } }).web_app.launcher.path;
    const scratch = dirname(dirname(launcher));
    expect(dirname(scratch)).toBe(temp);
    // A random name: another user cannot create or link the folder in a shared /tmp first.
    expect(basename(scratch)).toMatch(/^blockbench-mcp-headless-[0-9a-f-]{36}$/);
    if (process.platform !== "win32") expect((await stat(scratch)).mode & 0o777).toBe(0o700);
    expect(await readdir(temp)).toEqual([basename(scratch)]);
  }, 30_000);
});
