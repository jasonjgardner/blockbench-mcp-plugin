import { join } from "node:path";
import { z } from "zod";

/** Repository root shared by build, local desktop checks, and release verification. */
export const repositoryRoot = join(import.meta.dir, "..");

/** Tracked summary; raw models, screenshots, and logs stay in ignored artifacts/. */
export const evidencePath = "releases/desktop-smoke.json";

/**
 * Ordered desktop checks; identity creation supplies the inspection suite's mesh.
 * Each element is `{ name, script, result }`: the suite name recorded in the
 * evidence, the repository-relative live script that `release:smoke` runs, and the
 * repository-relative JSON file (`{ checks: string[] }`) that script writes on success.
 */
export const desktopSuites = [
  { name: "animation", script: "tests/live/animation-smoke.ts", result: "artifacts/animation/smoke-results.json" },
  { name: "actions", script: "tests/live/action-wrappers-smoke.ts", result: "artifacts/action-wrappers/smoke-results.json" },
  { name: "pbr", script: "tests/live/pbr-smoke.ts", result: "artifacts/pbr/smoke-results.json" },
  { name: "identity", script: "tests/live/mcp-identity-smoke.ts", result: "artifacts/mcp-identity/smoke-results.json" },
  { name: "inspection", script: "tests/live/inspection-smoke.ts", result: "artifacts/inspection/smoke-results.json" },
] as const;

/** One entry of {@link desktopSuites}; live scripts use it to locate their result and artifact files. */
export type DesktopSuite = (typeof desktopSuites)[number];

/** Suite names in release order (`"animation" | "actions" | ...`). */
export type DesktopSuiteName = DesktopSuite["name"];

/**
 * Lowercase hexadecimal SHA-256 digest (64 characters). Shared by the evidence
 * schemas and the live inspection suite so both accept exactly the same build IDs.
 */
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Repository-relative files outside the scanned directories that still influence
 * the shipped plugin or its release workflow.
 */
const ROOT_SOURCE_FILES = ["index.ts", "types.d.ts", "tsconfig.json", "package.json", "bun.lock", "icon.svg", "about.md", ".github/workflows/deploy.yml"];

/** Directories whose every file is part of the source fingerprint. */
const SOURCE_DIRECTORY_GLOB = "{server,lib,ui,macros,prompts,build,tests,lang}/**/*";

/** Generated on every prompt build with a timestamp, so it must not affect the fingerprint. */
const GENERATED_PROMPT_MANIFEST = "prompts/manifest.json";

/** Shared encoder: byte lengths prefix each hashed field. */
const textEncoder = new TextEncoder();

const sha256 = z.string().regex(SHA256_HEX_PATTERN);

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

/** One fingerprinted file: repository-relative path (either separator) and its text content. */
export interface ISourceEntry {
  path: string;
  content: string;
}

/**
 * What the evidence must match: the package version, the current source build ID,
 * and optionally the release tag being deployed (which must be `v<version>`).
 */
export interface IEvidenceExpectation {
  version: string;
  buildId: string;
  tag?: string;
}

/**
 * Hash ordered path/content pairs with normalized text line endings. Length-prefixed
 * fields prevent ambiguous concatenation; checkout CRLF conversion is immaterial.
 *
 * @param entries - Files to fingerprint, in any order.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function hashSourceEntries(entries: ReadonlyArray<ISourceEntry>): string {
  return entries
    .map(entry => ({ path: entry.path.replaceAll("\\", "/"), content: entry.content.replaceAll("\r\n", "\n") }))
    .toSorted((a, b) => a.path < b.path ? -1 : Number(a.path > b.path))
    .flatMap(entry => [entry.path, entry.content])
    .reduce((hasher, field) => hasher.update(`${textEncoder.encode(field).length}:${field}`), new Bun.CryptoHasher("sha256"))
    .digest("hex");
}

/**
 * Fingerprint runtime source, assets, dependencies, build scripts, tests and release
 * workflow. Generated docs, desktop receipts and timestamped prompt manifests are
 * excluded; prompt Markdown and its generator remain covered.
 *
 * @param root - Repository checkout to fingerprint; defaults to this repository.
 * @returns Lowercase hexadecimal SHA-256 build ID.
 * @throws When a required root file (e.g. `bun.lock`) or a scanned file cannot be read.
 */
export async function sourceBuildId(root = repositoryRoot): Promise<string> {
  const scanned = await Array.fromAsync(new Bun.Glob(SOURCE_DIRECTORY_GLOB).scan({ cwd: root, onlyFiles: true }));
  const sourceFiles = scanned.filter(path => path.replaceAll("\\", "/") !== GENERATED_PROMPT_MANIFEST);
  const paths = [...new Set([...ROOT_SOURCE_FILES, ...sourceFiles])];
  return hashSourceEntries(await Promise.all(paths.map(async path => ({ path, content: await Bun.file(join(root, path)).text() }))));
}

/**
 * Reject missing, failed or stale evidence before tag deployment. This is a
 * maintainer-supplied test record, not a signed desktop attestation.
 *
 * @param raw - Parsed JSON receipt of unknown shape.
 * @param expected - Version, source build ID and optional tag the receipt must match.
 * @returns The validated evidence.
 * @throws When the receipt is malformed or failed, does not match the source/version,
 * the tag is not `v<version>`, its timestamps are reversed, or any required suite is
 * missing or duplicated.
 */
export function validateDesktopEvidence(raw: unknown, expected: IEvidenceExpectation): DesktopEvidence {
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
