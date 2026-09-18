import { join } from "node:path";
import { VERSION } from "@/lib/constants";
import { evidencePath, repositoryRoot, sourceBuildId, validateDesktopEvidence } from "./release-evidence";

const path = join(repositoryRoot, evidencePath);

async function readEvidence(): Promise<unknown> {
  if (!await Bun.file(path).exists()) throw new Error(`Missing ${evidencePath}. Run bun run release:smoke and commit the passing record before tagging.`);
  try {
    return await Bun.file(path).json();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is not valid JSON: ${reason}`, { cause: error });
  }
}

try {
  const evidence = validateDesktopEvidence(await readEvidence(), {
    version: VERSION,
    buildId: await sourceBuildId(),
    tag: Bun.argv[2] ?? (Bun.env.GITHUB_REF_TYPE === "tag" ? Bun.env.GITHUB_REF_NAME : undefined),
  });
  console.log(`Verified desktop evidence for v${VERSION}, Blockbench ${evidence.blockbench.version}, build ${evidence.build_id}.`);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
