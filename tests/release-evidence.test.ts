import { describe, expect, test } from "bun:test";
import {
  SHA256_HEX_PATTERN,
  desktopReleaseCapabilitiesSchema,
  desktopSuites,
  hashSourceEntries,
  sourceBuildId,
  validateDesktopEvidence,
  type DesktopEvidence,
  type IEvidenceExpectation,
} from "@/build/release-evidence";

/** Hex characters in a SHA-256 digest; placeholder digests repeat one character this many times. */
const SHA256_HEX_LENGTH = 64;

const expected: IEvidenceExpectation = { version: "1.8.0", buildId: "a".repeat(SHA256_HEX_LENGTH), tag: "v1.8.0" };

function passingEvidence(): DesktopEvidence {
  return {
    schema_version: 1, status: "passed", version: expected.version,
    build_id: expected.buildId, build_mode: "production", bundle_sha256: "b".repeat(SHA256_HEX_LENGTH), bun_version: "1.3.14",
    blockbench: { version: "5.1.6", environment: "desktop", platform: "win32" },
    started_at: "2026-09-12T12:00:00.000Z", completed_at: "2026-09-12T12:01:00.000Z",
    suites: ["unit", ...desktopSuites.map(suite => suite.name)].map(name => ({ name, status: "passed", checks: ["assertion passed"] })),
  };
}

/**
 * Matches the validator's malformed-evidence error when its Zod issue list reports `issueMessage`.
 * The issues are embedded as JSON, so the message is JSON-escaped before being regex-escaped.
 */
function schemaFailure(issueMessage: string): RegExp {
  const escaped = JSON.stringify(issueMessage).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^Invalid desktop evidence: [\\s\\S]*"message": "${escaped}"`);
}

describe("desktop release gate", () => {
  test("rejects a development bundle even when its source ID matches production", () => {
    const production = { plugin: { version: expected.version, build_id: expected.buildId, build_mode: "production" }, blockbench: passingEvidence().blockbench };
    expect(desktopReleaseCapabilitiesSchema.safeParse(production).success).toBe(true);
    expect(desktopReleaseCapabilitiesSchema.safeParse({ ...production, plugin: { ...production.plugin, build_mode: "development" } }).success).toBe(false);
    expect(() => validateDesktopEvidence({ ...passingEvidence(), build_mode: "development" }, expected)).toThrow(schemaFailure('Invalid literal value, expected "production"'));
  });
  test("accepts a passing record matching the source and version tag", () => {
    expect(validateDesktopEvidence(passingEvidence(), expected).build_id).toBe(expected.buildId);
  });
  test("rejects stale source, version, or release tag", () => {
    expect(() => validateDesktopEvidence({ ...passingEvidence(), build_id: "c".repeat(SHA256_HEX_LENGTH) }, expected)).toThrow("does not match");
    expect(() => validateDesktopEvidence({ ...passingEvidence(), version: "1.7.0" }, expected)).toThrow("does not match");
    expect(() => validateDesktopEvidence(passingEvidence(), { ...expected, tag: "v1.9.0" })).toThrow("Release tag");
  });
  test.each([
    { label: "a missing record", raw: undefined },
    { label: "an empty record", raw: {} },
    { label: "a failed run", raw: { ...passingEvidence(), status: "failed" } },
    { label: "a web session", raw: { ...passingEvidence(), blockbench: { version: "5.1.6", environment: "web", platform: "web" } } },
  ])("rejects web sessions, failed runs, incomplete and malformed records: $label", ({ raw }) => {
    expect(() => validateDesktopEvidence(raw, expected)).toThrow("Invalid desktop evidence");
  });
  test("requires every suite exactly once with nonempty successful checks", () => {
    const evidence = passingEvidence();
    expect(() => validateDesktopEvidence({ ...evidence, suites: evidence.suites.slice(1) }, expected)).toThrow("exactly");
    expect(() => validateDesktopEvidence({ ...evidence, suites: [...evidence.suites, evidence.suites[0]] }, expected)).toThrow("exactly");
    expect(() => validateDesktopEvidence({ ...evidence, suites: evidence.suites.map(suite => ({ ...suite, checks: [] })) }, expected)).toThrow(schemaFailure("Array must contain at least 1 element(s)"));
    expect(() => validateDesktopEvidence({ ...evidence, suites: evidence.suites.map(suite => ({ ...suite, status: "failed" })) }, expected)).toThrow(schemaFailure('Invalid literal value, expected "passed"'));
  });
  test("rejects reversed timestamps", () => {
    expect(() => validateDesktopEvidence({ ...passingEvidence(), completed_at: "2026-09-11T12:00:00.000Z" }, expected)).toThrow("precedes");
  });
});

describe("source build identity", () => {
  test("ignores platform path separators, checkout line endings and enumeration order", () => {
    expect(hashSourceEntries([{ path: "lib/a.ts", content: "a\nb\n" }, { path: "index.ts", content: "c" }]))
      .toBe(hashSourceEntries([{ path: "index.ts", content: "c" }, { path: "lib\\a.ts", content: "a\r\nb\r\n" }]));
  });
  test("changes when source content or a path changes", () => {
    const original = hashSourceEntries([{ path: "a.ts", content: "ab" }]);
    expect(hashSourceEntries([{ path: "a.ts", content: "ac" }])).not.toBe(original);
    expect(hashSourceEntries([{ path: "b.ts", content: "ab" }])).not.toBe(original);
    expect(hashSourceEntries([{ path: "a", content: "bc" }])).not.toBe(hashSourceEntries([{ path: "ab", content: "c" }]));
  });
  test("discovers actual repository inputs without requiring a receipt", async () => {
    expect(await sourceBuildId()).toMatch(SHA256_HEX_PATTERN);
  });
});
