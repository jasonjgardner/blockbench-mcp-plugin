import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliAgent } from "./cli-agent";
import type { Model } from "./config";
import { PolicyProxy } from "./proxy";
import { runners } from "./runners";
import type { IAgentSetup } from "./trial";

/** Runners that drive a local agent CLI rather than Replicate predictions. */
export type CliRunnerName = keyof typeof runners;

/** Versions and backend recorded for a CLI model before its trials run. */
export interface ICliPreflight {
  runner: CliRunnerName;
  version: string;
  backend: "ollama" | "account";
  model: string;
}

/** True for models driven by a local agent CLI. */
export function isCliModel(
  model: Model,
): model is Model & { runner: CliRunnerName } {
  return model.runner !== "replicate";
}

/**
 * Checks that a model's CLI is installed (and, for Ollama, that the model is
 * pulled) using Bun's shell. Throws a readable reason when it cannot run.
 */
export async function preflightCli(
  model: Model & { runner: CliRunnerName },
): Promise<ICliPreflight> {
  const version = await $`${model.runner} --version`.quiet().nothrow();
  if (version.exitCode !== 0) {
    throw new Error(
      `${model.runner} CLI is not available: ${version.stderr.toString().trim()}`,
    );
  }
  if (model.backend === "ollama") {
    const show = await $`ollama show ${model.model}`.quiet().nothrow();
    if (show.exitCode !== 0) {
      throw new Error(
        `Ollama model ${model.model} is not available: ${show.stderr.toString().trim()}`,
      );
    }
  }
  return {
    runner: model.runner,
    version: version.stdout.toString().trim(),
    backend: model.backend === "ollama" ? "ollama" : "account",
    model: model.model,
  };
}

/**
 * MCP server names in the operator's Codex config. Codex runs switch each one off,
 * so a personal `blockbench` server cannot bypass the benchmark proxy.
 */
export async function codexMcpServers(): Promise<string[]> {
  const home =
    Bun.env.CODEX_HOME ??
    join(Bun.env.USERPROFILE ?? Bun.env.HOME ?? "", ".codex");
  const file = Bun.file(join(home, "config.toml"));
  if (!(await file.exists())) return [];
  const config: unknown = Bun.TOML.parse(await file.text());
  if (
    typeof config !== "object" ||
    config === null ||
    !("mcp_servers" in config)
  )
    return [];
  const servers = config.mcp_servers;
  return typeof servers === "object" && servers !== null
    ? Object.keys(servers)
    : [];
}

/**
 * Builds a trial's agent factory: starts the policy proxy on the trial's MCP
 * connection and returns a CLI agent in an empty scratch folder outside the repo.
 */
export function cliAgentFactory(
  model: Model & { runner: CliRunnerName },
  runId: string,
  trialId: string,
  codexServers: readonly string[],
): (setup: IAgentSetup) => Promise<CliAgent> {
  return async (setup) => {
    const workdir = join(tmpdir(), "blockbench-benchmark", runId, trialId);
    // Creates the folder; the CLIs need an existing working directory.
    await Bun.write(join(workdir, ".benchmark-workdir"), `${trialId}\n`);
    const proxy = await PolicyProxy.start({
      upstream: setup.mcp,
      evidence: setup.evidence,
      context: setup.context,
      project: setup.project,
      view: setup.view,
      observationCharacters: setup.limits.observationCharacters,
    });
    await setup.evidence.event("proxy-started", { url: proxy.url, workdir });
    return new CliAgent({
      runner: runners[model.runner],
      model,
      proxy,
      evidence: setup.evidence,
      context: setup.context,
      limits: setup.limits,
      signal: setup.signal,
      project: setup.project,
      view: setup.view,
      workdir,
      codexServers,
    });
  };
}
