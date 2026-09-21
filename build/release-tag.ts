/**
 * Creates the release tag only after the same checks CI runs on it pass locally.
 *
 * The tag workflow rejects desktop evidence whose source fingerprint no longer
 * matches, and any commit after `release:smoke` (a doc comment is enough)
 * changes that fingerprint. Verifying here, against the committed tree, turns
 * that failure into a message before anything reaches GitHub.
 *
 * Usage: `bun run release:tag [--push]`.
 *
 * @module
 */
import { join } from "node:path";
import { $ } from "bun";
import { VERSION } from "@/lib/constants";
import { evidencePath, repositoryRoot, sourceBuildId, validateDesktopEvidence } from "./release-evidence";

/** Facts about the checkout that decide whether tagging is allowed. */
export interface ITagPreflight {
  /** `git status --porcelain` output; anything here means the evidence may describe other source. */
  readonly status: string;
  /** Whether `v<version>` already exists locally. */
  readonly tagExists: boolean;
  readonly version: string;
}

/**
 * Explains why the checkout cannot be tagged, or returns `null` when it can.
 * Separated from the git calls so the rules are unit-testable.
 *
 * @param preflight - Current checkout facts.
 * @returns A message for the maintainer, or `null` to proceed.
 */
export function tagBlocker(preflight: ITagPreflight): string | null {
  if (preflight.status.trim() !== "") {
    return `The working tree has uncommitted changes; commit or stash them so the tag matches the tested source:\n${preflight.status.trimEnd()}`;
  }
  if (preflight.tagExists) return `Tag v${preflight.version} already exists. Bump package.json or delete the tag first.`;
  return null;
}

async function main(): Promise<void> {
  const tag = `v${VERSION}`;
  const evidence = await Bun.file(join(repositoryRoot, evidencePath)).json();
  validateDesktopEvidence(evidence, { version: VERSION, buildId: await sourceBuildId(), tag });

  const status = await $`git status --porcelain`.cwd(repositoryRoot).text();
  const tagExists = (await $`git tag --list ${tag}`.cwd(repositoryRoot).text()).trim() !== "";
  const blocker = tagBlocker({ status, tagExists, version: VERSION });
  if (blocker) throw new Error(blocker);

  await $`git tag -a ${tag} -m ${tag}`.cwd(repositoryRoot);
  console.log(`Created ${tag} on verified desktop evidence (build ${String(evidence.build_id).slice(0, 12)}…).`);
  if (!Bun.argv.includes("--push")) {
    console.log(`Push it with: git push origin ${tag}`);
    return;
  }
  await $`git push origin ${tag}`.cwd(repositoryRoot);
  console.log(`Pushed ${tag}; the Deploy workflow will verify and publish it.`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
