import { join } from "node:path";
import { z } from "zod";
import { VERSION } from "@/lib/constants";
import { resolveEndpoint, withClient } from "@/tests/live/harness";
import {
  type DesktopEvidence, type DesktopSuite, desktopReleaseCapabilitiesSchema, desktopSuites, evidencePath, repositoryRoot, sourceBuildId, validateDesktopEvidence,
} from "./release-evidence";

/** Repository-relative production bundle that must be loaded in Blockbench desktop. */
const BUNDLE_PATH = "dist/mcp.js";
/** Schema version of the receipt written to {@link evidencePath}. */
const RECEIPT_SCHEMA_VERSION = 1;

const endpoint = resolveEndpoint(Bun.argv[2]);
const receipt = join(repositoryRoot, evidencePath);
const bundlePath = join(repositoryRoot, BUNDLE_PATH);
const startedAt = new Date().toISOString();
const resultSchema = z.object({ checks: z.array(z.string().min(1)).min(1) });

/** Suite evidence entry, as stored in the receipt. */
type SuiteEvidence = DesktopEvidence["suites"][number];

/** Desktop runtime description returned by a production plugin build. */
type DesktopCapabilities = z.infer<typeof desktopReleaseCapabilitiesSchema>;

/** Snapshot taken before the suites run; it must be unchanged when they finish. */
interface IEnvironment {
  buildId: string;
  desktop: DesktopCapabilities;
  bundleSha256: string;
}

async function inspectDesktop(): Promise<DesktopCapabilities> {
  return withClient("blockbench-release-smoke", endpoint, async client => {
    const result = await client.callTool({ name: "get_capabilities", arguments: {} });
    if (result.isError) throw new Error(`get_capabilities failed: ${JSON.stringify(result.content)}`);
    const parsed = desktopReleaseCapabilitiesSchema.safeParse(result.structuredContent);
    if (!parsed.success) {
      throw new Error(`A production build in Blockbench desktop is required: ${parsed.error.message}. Run bun run build and reload ${BUNDLE_PATH} before release:smoke.`);
    }
    return parsed.data;
  });
}

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args.join(" ")} failed with exit code ${code}.`);
}

async function sha256Of(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
}

async function writeReceipt(payload: unknown): Promise<void> {
  await Bun.write(receipt, JSON.stringify(payload, null, 2) + "\n");
}

async function runSuite(suite: DesktopSuite): Promise<SuiteEvidence> {
  const resultPath = join(repositoryRoot, suite.result);
  await Bun.write(resultPath, "{}\n");
  await run(["run", suite.script, endpoint.href]);
  const result = resultSchema.parse(await Bun.file(resultPath).json());
  return { name: suite.name, status: "passed", checks: result.checks };
}

async function captureEnvironment(): Promise<IEnvironment> {
  const buildId = await sourceBuildId();
  const desktop = await inspectDesktop();
  if (desktop.plugin.version !== VERSION || desktop.plugin.build_id !== buildId) {
    throw new Error(`Loaded desktop plugin is stale. Run bun run build, reload ${BUNDLE_PATH} in Blockbench, then repeat release:smoke.`);
  }
  const bundleSha256 = await sha256Of(bundlePath);
  if (!(await Bun.file(bundlePath).text()).includes(buildId)) throw new Error(`${BUNDLE_PATH} does not contain the loaded source build ID. Rebuild and reload it.`);
  return { buildId, desktop, bundleSha256 };
}

async function assertEnvironmentUnchanged({ buildId, desktop, bundleSha256 }: IEnvironment): Promise<void> {
  const after = await inspectDesktop();
  const finalBundleHash = await sha256Of(bundlePath);
  if (await sourceBuildId() !== buildId || JSON.stringify(after) !== JSON.stringify(desktop) || finalBundleHash !== bundleSha256) {
    throw new Error("Source, bundle or desktop environment changed during testing. Rebuild, reload, and repeat release:smoke.");
  }
}

async function main(): Promise<void> {
  // A failed repeat must never leave an earlier success eligible for release.
  await writeReceipt({ schema_version: RECEIPT_SCHEMA_VERSION, status: "running", started_at: startedAt });
  const environment = await captureEnvironment();
  await run(["test"]);
  const unitSuite: SuiteEvidence = { name: "unit", status: "passed", checks: ["bun test exited successfully"] };
  // Suites intentionally run sequentially because Blockbench has one active project.
  const suites = [unitSuite, ...await Array.fromAsync(desktopSuites, runSuite)];
  await assertEnvironmentUnchanged(environment);
  const evidence = validateDesktopEvidence({
    schema_version: RECEIPT_SCHEMA_VERSION, status: "passed", version: VERSION, build_id: environment.buildId, build_mode: "production",
    bundle_sha256: environment.bundleSha256, bun_version: Bun.version, blockbench: environment.desktop.blockbench,
    started_at: startedAt, completed_at: new Date().toISOString(), suites,
  }, { version: VERSION, buildId: environment.buildId });
  await writeReceipt(evidence);
  console.log(`Desktop release checks passed. Commit ${evidencePath} with the tested source before tagging v${VERSION}.`);
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await writeReceipt({ schema_version: RECEIPT_SCHEMA_VERSION, status: "failed", started_at: startedAt, error: message });
  console.error(message);
  process.exitCode = 1;
}
