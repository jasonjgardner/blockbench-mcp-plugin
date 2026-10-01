import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateEngineDir, prepareRenderRuntime } from "./runtime";

/** A stand-in npm that logs its command and "installs" the package the runtime checks for. */
async function fakeNpm(dir: string): Promise<string> {
  if (process.platform === "win32") {
    const path = join(dir, "npm.cmd");
    const probe = "node_modules\\@rendergl\\headless-three-webgpu";
    await Bun.write(path, `@echo off\r\necho %1>>calls.txt\r\nmkdir ${probe} 2>nul\r\necho {}>${probe}\\package.json\r\n`);
    return path;
  }
  const path = join(dir, "npm");
  const probe = "node_modules/@rendergl/headless-three-webgpu";
  await Bun.write(path, `#!/bin/sh\necho "$1" >> calls.txt\nmkdir -p ${probe}\necho {} > ${probe}/package.json\n`);
  await chmod(path, 0o755);
  return path;
}

describe("render runtime", () => {
  let work = "";

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "bb-headless-runtime-"));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  test("a lockfile beside the manifest is copied and installed with npm ci; changing it reinstalls", async () => {
    // The package layout the runtime expects: <package>/package.json beside <package>/render/engine.
    const shipped = locateEngineDir();
    const engineDir = join(work, "headless", "render", "engine");
    await cp(shipped, engineDir, { recursive: true });
    await Bun.write(join(work, "headless", "package.json"), await Bun.file(join(shipped, "..", "..", "package.json")).text());
    const home = join(work, "home");
    const npm = await fakeNpm(work);
    const prepare = () => prepareRenderRuntime({ home, engineDir, npm });
    const calls = async () => (await Bun.file(join(home, "calls.txt")).text()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    const cli = await prepare();
    expect(await Bun.file(cli).exists()).toBe(true);
    expect(await calls()).toEqual(["install"]);

    const lock = JSON.stringify({ name: "blockbench-mcp-headless-render", lockfileVersion: 3, packages: {} });
    await Bun.write(join(work, "headless", "package-lock.json"), lock);
    await prepare();
    await prepare();
    expect(await Bun.file(join(home, "package-lock.json")).text()).toBe(lock);
    expect(await calls()).toEqual(["install", "ci"]);
  }, 60_000);
});
