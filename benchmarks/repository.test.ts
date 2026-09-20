import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Evidence } from "./evidence";

/** Keeps benchmark evidence out of the repository and empty files out of commits. */
describe("repository hygiene", () => {
  const benchmarks = import.meta.dir;

  test("run folders under results/ are ignored; the folder guide is not", async () => {
    const ignored = await $`git check-ignore -q results/any-run/summary.json`
      .cwd(benchmarks)
      .nothrow()
      .quiet();
    const guide = await $`git check-ignore -q results/README.md`
      .cwd(benchmarks)
      .nothrow()
      .quiet();
    expect(ignored.exitCode).toBe(0);
    expect(guide.exitCode).toBe(1);
  });

  test("no file git would pick up under benchmarks/ is empty", async () => {
    const listed =
      await $`git ls-files --cached --others --exclude-standard -- .`
        .cwd(benchmarks)
        .quiet()
        .text();
    const files = listed.split("\n").filter(Boolean);
    const sizes = await Promise.all(
      files.map(async (path) => {
        const file = Bun.file(join(benchmarks, path));
        return (await file.exists()) ? { path, size: file.size } : undefined;
      }),
    );
    const empty = sizes
      .filter((entry) => entry?.size === 0)
      .map((entry) => entry?.path);
    expect(files.length).toBeGreaterThan(0);
    expect(empty).toEqual([]);
  });

  test("evidence skips empty text instead of writing an empty file", async () => {
    const root = join(tmpdir(), `blockbench-empty-${Bun.randomUUIDv7()}`);
    const evidence = new Evidence(root);
    await evidence.text("cli/stage-1.stderr", "");
    await evidence.text("cli/stage-1.stdout", "{}");
    expect(await Bun.file(join(root, "cli/stage-1.stderr")).exists()).toBe(
      false,
    );
    expect(await Bun.file(join(root, "cli/stage-1.stdout")).text()).toBe("{}");
    await $`rm -rf ${root}`.quiet();
  });
});
