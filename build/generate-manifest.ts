import { Glob } from "bun";
import { log } from "./utils";
import { version } from "../package.json";
import type { PromptManifest } from "../lib/promptLoader";

async function main() {
  log.header("Prompt Manifest Generator");

  const promptsDir = import.meta.dir + "/../prompts";
  const glob = new Glob("*.md");

  log.step("Scanning prompts directory...");
  const prompts: Record<string, string> = {};
  const entries: string[] = [];

  for await (const file of glob.scan({ cwd: promptsDir })) {
    entries.push(file);
  }

  entries.sort();

  for (const file of entries) {
    const name = file.replace(/\.md$/, "");
    const content = await Bun.file(`${promptsDir}/${file}`).text();
    prompts[name] = content;
    log.step(`${name} (${content.length} chars)`);
  }

  const manifest: PromptManifest = {
    version,
    generatedAt: new Date().toISOString(),
    prompts,
  };

  const manifestPath = `${promptsDir}/manifest.json`;
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));

  log.success(
    `Manifest generated: ${entries.length} prompts, v${version}`
  );
}

main().catch((err) => {
  log.error(`Manifest generation failed: ${err}`);
  process.exit(1);
});
