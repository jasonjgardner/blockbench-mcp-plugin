import { join } from "node:path";
import { z } from "zod";

/** Repository root shared by build, local desktop checks, and release verification. */
export const repositoryRoot = join(import.meta.dir, "..");

/** Tracked summary; raw models, screenshots, and logs stay in ignored artifacts/. */
export const evidencePath = "releases/desktop-smoke.json";

/** Ordered desktop checks; identity creation supplies the inspection suite's mesh. */
export const desktopSuites = [
  { name: "actions", script: "tests/live/action-wrappers-smoke.ts", result: "artifacts/action-wrappers/smoke-results.json" },
  { name: "pbr", script: "tests/live/pbr-smoke.ts", result: "artifacts/pbr/smoke-results.json" },
  { name: "identity", script: "tests/live/mcp-identity-smoke.ts", result: "artifacts/mcp-identity/smoke-results.json" },
  { name: "inspection", script: "tests/live/inspection-smoke.ts", result: "artifacts/inspection/smoke-results.json" },
] as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Require a production desktop runtime, not a development build with the same source ID. */
export const desktopReleaseCapabilitiesSchema = z.object({
  plugin: z.object({ version: z.string(), build_id: sha256, build_mode: z.literal("production") }),
  blockbench: z.object({ version: z.string(), environment: z.literal("desktop"), platform: z.string() }),
});
const suiteSchema = z.object({
  name: z.string(),
  status: z.literal("passed"),
  checks: z.array(z.string().min(1)).min(1),
});

/** Strict receipt shape: each successful suite records the assertions it exercised. */
export const desktopEvidenceSchema = z.object({
  schema_version: z.literal(1),
  status: z.literal("passed"),
  version: z.string().min(1),
  build_id: sha256,
  build_mode: z.literal("production"),
  bundle_sha256: sha256,
  bun_version: z.string().min(1),
  blockbench: z.object({
    version: z.string().min(1),
    environment: z.literal("desktop"),
    platform: z.string().min(1),
  }),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime(),
  suites: z.array(suiteSchema),
}).strict();

/** Serializable local desktop evidence committed alongside the tested source. */
export type DesktopEvidence = z.infer<typeof desktopEvidenceSchema>;

/**
 * Hash ordered path/content pairs with normalized text line endings. Length-prefixed
 * fields prevent ambiguous concatenation; checkout CRLF conversion is immaterial.
 */
export function hashSourceEntries(entries: ReadonlyArray<{ path: string; content: string }>): string {
  const hash = new Bun.CryptoHasher("sha256");
  entries.map(entry => ({ path: entry.path.replaceAll("\\", "/"), content: entry.content.replaceAll("\r\n", "\n") }))
    .toSorted((a, b) => a.path < b.path ? -1 : Number(a.path > b.path))
    .forEach(entry => {
      [entry.path, entry.content].forEach(field => hash.update(`${new TextEncoder().encode(field).length}:${field}`));
    });
  return hash.digest("hex");
}

/**
 * Fingerprint runtime source, assets, dependencies, build scripts, tests and release
 * workflow. Generated docs, desktop receipts and timestamped prompt manifests are
 * excluded; prompt Markdown and its generator remain covered.
 */
export async function sourceBuildId(root = repositoryRoot): Promise<string> {
  const rootFiles = ["index.ts", "types.d.ts", "tsconfig.json", "package.json", "bun.lock", "icon.svg", "about.md", ".github/workflows/deploy.yml"];
  const sourceFiles = Array.from(new Bun.Glob("{server,lib,ui,macros,prompts,build,tests,lang}/**/*").scanSync({ cwd: root, onlyFiles: true }))
    .filter(path => path.replaceAll("\\", "/") !== "prompts/manifest.json");
  const paths = [...new Set([...rootFiles, ...sourceFiles])];
  return hashSourceEntries(await Promise.all(paths.map(async path => ({ path, content: await Bun.file(join(root, path)).text() }))));
}

/**
 * Reject missing, failed or stale evidence before tag deployment. This is a
 * maintainer-supplied test record, not a signed desktop attestation.
 */
export function validateDesktopEvidence(raw: unknown, expected: { version: string; buildId: string; tag?: string }): DesktopEvidence {
  const parsed = desktopEvidenceSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid desktop evidence: ${parsed.error.message}. Run bun run release:smoke on Blockbench desktop.`);
  const evidence = parsed.data;
  if (evidence.version !== expected.version || evidence.build_id !== expected.buildId) {
    throw new Error("Desktop evidence does not match this source/version. Rebuild, reload in Blockbench, and run bun run release:smoke.");
  }
  if (expected.tag && expected.tag !== `v${expected.version}`) throw new Error(`Release tag must be v${expected.version}.`);
  if (Date.parse(evidence.completed_at) < Date.parse(evidence.started_at)) throw new Error("Desktop evidence completion precedes its start.");
  const required = ["unit", ...desktopSuites.map(suite => suite.name)];
  if (evidence.suites.length !== required.length || required.some(name => evidence.suites.filter(suite => suite.name === name).length !== 1)) {
    throw new Error(`Desktop evidence must contain exactly these passing suites: ${required.join(", ")}.`);
  }
  return evidence;
}
