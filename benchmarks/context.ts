import { relative, resolve } from "node:path";
import { sequential } from "./config";
import { sha256 } from "./evidence";

/** Guidance files every run must snapshot; a missing or empty file aborts before any trial. */
const requiredGuidance = [
  "AGENTS.md",
  "skills/blockbench-use/SKILL.md",
  "skills/blockbench-modeling/SKILL.md",
  "skills/blockbench-texturing/SKILL.md",
  "skills/blockbench-animation/SKILL.md",
] as const;

/** Frozen project guidance; keys are portable relative paths and values are exact UTF-8 source text. */
export interface IContext {
  files: Record<string, string>;
  hashes: Record<string, string>;
  agents: Record<string, string>;
}

/** Lists Codex agent definitions, treating an absent agent directory as "no subagents". */
async function agentFiles(root: string): Promise<string[]> {
  // Scan the specific agent directory rather than traversing the protected .codex parent.
  const scan = Array.fromAsync(
    new Bun.Glob("*.toml").scan({
      cwd: resolve(root, ".codex/agents"),
      dot: true,
    }),
  );
  return scan.catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return [];
    throw error;
  });
}

/** Extracts a subagent's name and instructions from Codex TOML; malformed definitions are ignored. */
function agentDefinition(
  text: string,
): [name: string, instructions: string] | undefined {
  const parsed: unknown = Bun.TOML.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("name" in parsed) ||
    !("developer_instructions" in parsed)
  ) {
    return undefined;
  }
  if (
    typeof parsed.name !== "string" ||
    typeof parsed.developer_instructions !== "string"
  )
    return undefined;
  return [parsed.name, parsed.developer_instructions];
}

/** Loads canonical skills/references and Codex subagent instructions once for an entire run. */
export async function loadContext(root: string): Promise<IContext> {
  const skills = await Array.fromAsync(
    new Bun.Glob("**/*.md").scan({ cwd: resolve(root, "skills") }),
  );
  const agents = await agentFiles(root);
  const paths = [
    "AGENTS.md",
    ...skills.map((path) => `skills/${path}`),
    ...agents.map((name) => `.codex/agents/${name}`),
  ].toSorted();
  const sources = await sequential(paths, async (path) => ({
    key: relative(resolve(root), resolve(root, path)).replaceAll("\\", "/"),
    text: await Bun.file(resolve(root, path)).text(),
  }));
  const files = Object.fromEntries(sources.map(({ key, text }) => [key, text]));
  const missing = requiredGuidance.find((key) => !files[key]);
  if (missing) throw new Error(`Missing required Project guidance: ${missing}`);
  return {
    files,
    hashes: Object.fromEntries(
      sources.map(({ key, text }) => [key, sha256(text)]),
    ),
    agents: Object.fromEntries(
      sources.flatMap(({ key, text }) => {
        const definition = key.startsWith(".codex/agents/")
          ? agentDefinition(text)
          : undefined;
        return definition ? [definition] : [];
      }),
    ),
  };
}
