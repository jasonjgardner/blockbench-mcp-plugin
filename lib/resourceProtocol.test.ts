import { describe, expect, test } from "bun:test";
import { isRecord } from "@/tests/helpers/assertions";

describe("resource JSON-RPC responses", () => {
  test("initial and reconstructed servers expose live files and return protocol errors", async () => {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "run", "tests/helpers/resource-protocol-fixture.ts"], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect({ exitCode, stderr: exitCode ? stderr : "" }).toEqual({ exitCode: 0, stderr: "" });
    const output: unknown = JSON.parse(stdout.trim());
    if (!Array.isArray(output) || output.length !== 2) throw new Error("Expected both resource registration modes.");
    output.forEach((result: unknown) => {
      if (!isRecord(result)) throw new Error("Expected resource protocol result object.");
      expect(result.emptyList).toMatchObject({ resources: [] });
      expect(result.unknown).toMatchObject({ code: -32602 });
      expect(result.missing).toMatchObject({ code: -32602, data: { uri: "projects://missing" } });
      expect(result.malformed).toMatchObject({ code: -32602 });
      expect(result.internal).toMatchObject({ code: -32603, data: { uri: "failure://read" } });
      expect(result.listingFailure).toMatchObject({ code: -32603 });
      expect(result.file).toMatchObject({ name: "Unsaved.bbmodel", mimeType: "application/json" });
      expect(result.contents).toMatchObject({
        contents: [{
          mimeType: "application/json",
          text: '{"meta":{"format_version":"5.0"},"elements":[{"name":"Live cube"}]}',
        }],
      });
    });
  });
});
