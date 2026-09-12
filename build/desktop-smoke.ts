import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { desktopReleaseCapabilitiesSchema, desktopSuites, evidencePath, repositoryRoot, sourceBuildId, validateDesktopEvidence } from "./release-evidence";
import { version } from "../package.json";

const endpoint = new URL(Bun.argv[2] ?? "http://localhost:3000/bb-mcp");
const receipt = join(repositoryRoot, evidencePath);
const startedAt = new Date().toISOString();
const resultSchema = z.object({ checks: z.array(z.string().min(1)).min(1) });

async function inspectDesktop() {
  const client = new Client({ name: "blockbench-release-smoke", version });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const result = await client.callTool({ name: "get_capabilities", arguments: {} });
    if (result.isError) throw new Error(`get_capabilities failed: ${JSON.stringify(result.content)}`);
    const parsed = desktopReleaseCapabilitiesSchema.safeParse(result.structuredContent);
    if (!parsed.success) throw new Error("A production build in Blockbench desktop is required. Run bun run build and reload dist/mcp.js before release:smoke.");
    return parsed.data;
  } finally {
    await client.close();
  }
}

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args.join(" ")} failed with exit code ${code}.`);
}

try {
  // A failed repeat must never leave an earlier success eligible for release.
  await Bun.write(receipt, JSON.stringify({ schema_version: 1, status: "running", started_at: startedAt }, null, 2) + "\n");
  const buildId = await sourceBuildId();
  const desktop = await inspectDesktop();
  if (desktop.plugin.version !== version || desktop.plugin.build_id !== buildId) {
    throw new Error("Loaded desktop plugin is stale. Run bun run build, reload dist/mcp.js in Blockbench, then repeat release:smoke.");
  }
  const bundle = Bun.file(join(repositoryRoot, "dist/mcp.js"));
  const bundleBytes = await bundle.arrayBuffer();
  const bundleSha256 = new Bun.CryptoHasher("sha256").update(bundleBytes).digest("hex");
  if (!(await bundle.text()).includes(buildId)) throw new Error("dist/mcp.js does not contain the loaded source build ID. Rebuild and reload it.");
  await run(["test"]);
  const suites = [{ name: "unit", status: "passed" as const, checks: ["bun test exited successfully"] }];
  // Suites intentionally run sequentially because Blockbench has one active project.
  for (const suite of desktopSuites) {
    await Bun.write(join(repositoryRoot, suite.result), "{}\n");
    await run(["run", suite.script, endpoint.href]);
    const result = resultSchema.parse(await Bun.file(join(repositoryRoot, suite.result)).json());
    suites.push({ name: suite.name, status: "passed", checks: result.checks });
  }
  const after = await inspectDesktop();
  const finalBundleHash = new Bun.CryptoHasher("sha256").update(await bundle.arrayBuffer()).digest("hex");
  if (await sourceBuildId() !== buildId || JSON.stringify(after) !== JSON.stringify(desktop) || finalBundleHash !== bundleSha256) {
    throw new Error("Source, bundle or desktop environment changed during testing. Rebuild, reload, and repeat release:smoke.");
  }
  const evidence = validateDesktopEvidence({
    schema_version: 1, status: "passed", version, build_id: buildId, build_mode: "production", bundle_sha256: bundleSha256,
    bun_version: Bun.version, blockbench: desktop.blockbench,
    started_at: startedAt, completed_at: new Date().toISOString(), suites,
  }, { version, buildId });
  await Bun.write(receipt, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Desktop release checks passed. Commit ${evidencePath} with the tested source before tagging v${version}.`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await Bun.write(receipt, JSON.stringify({ schema_version: 1, status: "failed", started_at: startedAt, error: message }, null, 2) + "\n");
  console.error(message);
  process.exitCode = 1;
}
