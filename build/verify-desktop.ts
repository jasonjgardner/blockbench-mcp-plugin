import { join } from "node:path";
import { evidencePath, repositoryRoot, sourceBuildId, validateDesktopEvidence } from "./release-evidence";
import { version } from "../package.json";

const path = join(repositoryRoot, evidencePath);
try {
  if (!await Bun.file(path).exists()) throw new Error(`Missing ${evidencePath}. Run bun run release:smoke and commit the passing record before tagging.`);
  const evidence = validateDesktopEvidence(await Bun.file(path).json(), {
    version,
    buildId: await sourceBuildId(),
    tag: Bun.argv[2] ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined),
  });
  console.log(`Verified desktop evidence for v${version}, Blockbench ${evidence.blockbench.version}, build ${evidence.build_id}.`);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
