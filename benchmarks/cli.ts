import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  matrix,
  sequential,
  suiteSchema,
  type ITrial,
  type Suite,
} from "./config";
import { type IContext, loadContext } from "./context";
import { CostLedger, formatCeilings, projectCeilings } from "./cost";
import { Evidence, errorText, redact, sha256 } from "./evidence";
import type { CliAgent } from "./cli-agent";
import {
  cliAgentFactory,
  codexMcpServers,
  type ICliPreflight,
  isCliModel,
  preflightCli,
} from "./local";
import { acquireLock, connect } from "./mcp";
import { prompts } from "./prompts";
import { ReplicateProvider, type IResolvedModel } from "./replicate";
import { runTrial } from "./trial";

const root = resolve(import.meta.dir, "..");
const usage =
  "bun run benchmarks/cli.ts plan|run [--models id,id] [--cases id,id] [--conditions empty,scaffold,repair] [--repeat N] [--suite path] [--project-root path] [--max-cost USD]";
const commands = ["plan", "run"] as const;
const cliOptions = {
  suite: { type: "string" },
  models: { type: "string" },
  cases: { type: "string" },
  conditions: { type: "string" },
  repeat: { type: "string" },
  "project-root": { type: "string" },
  "max-cost": { type: "string" },
  help: { type: "boolean" },
} as const;

type Command = (typeof commands)[number];
type Options = ReturnType<
  typeof parseArgs<{ options: typeof cliOptions }>
>["values"];
type Row = Record<string, unknown>;

/** Everything a live run needs after the offline plan has been archived. */
interface ILiveRun {
  suite: Suite;
  trials: ITrial[];
  context: IContext;
  evidence: Evidence;
  directory: string;
  endpoint: string;
  /** Replicate token; absent when every selected model runs through a local CLI. */
  token: string | undefined;
  ledger: CostLedger;
  runId: string;
}

/** A model that passed preflight: Replicate metadata or a checked local CLI. */
type Resolution = IResolvedModel | ICliPreflight;

function isCommand(value: string): value is Command {
  return commands.some((command) => command === value);
}

function select<T>(
  items: readonly T[],
  filter: string | undefined,
  key: (item: T) => string,
): T[] {
  if (!filter) return [...items];
  const requested = filter.split(",");
  const unknown = requested.find(
    (id) => !items.some((item) => key(item) === id),
  );
  if (unknown !== undefined) throw new Error(`Unknown selection: ${unknown}`);
  return items.filter((item) => requested.includes(key(item)));
}

async function loadSuite(values: Options): Promise<Suite> {
  const raw: unknown = await Bun.file(
    resolve(values.suite ?? resolve(import.meta.dir, "suite.json")),
  ).json();
  const source = suiteSchema.parse(raw);
  return suiteSchema.parse({
    ...source,
    models: select(source.models, values.models, (model) => model.id),
    cases: select(source.cases, values.cases, (asset) => asset.id),
    conditions: select(
      source.conditions,
      values.conditions,
      (condition) => condition,
    ),
    repetitions:
      values.repeat === undefined ? source.repetitions : Number(values.repeat),
  });
}

function mcpEndpoint(): string {
  const endpoint = Bun.env.BLOCKBENCH_MCP_URL ?? "http://localhost:3000/bb-mcp";
  const url = new URL(endpoint);
  if (
    url.username ||
    url.password ||
    url.search ||
    !["http:", "https:"].includes(url.protocol)
  ) {
    throw new Error(
      "MCP URL must be HTTP(S), without credentials or query parameters.",
    );
  }
  return endpoint;
}

/**
 * The Replicate token for a live run that includes Replicate models; `undefined`
 * for an offline plan or a run that only uses local agent CLIs.
 */
function liveToken(command: Command, suite: Suite): string | undefined {
  if (command === "plan" || suite.models.every(isCliModel)) return undefined;
  const token = Bun.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("Set REPLICATE_API_TOKEN before a live run.");
  return token;
}

/**
 * Effective USD cap: the lower of `--max-cost` and the suite's `maxCostUsd`, so a
 * budget suite's cap cannot be raised from the command line. Absent both, no cap.
 */
function maxCost(value: string | undefined, suite: Suite): number | undefined {
  if (value === undefined) return suite.maxCostUsd;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("--max-cost must be a positive number of US dollars.");
  }
  return Math.min(amount, suite.maxCostUsd ?? amount);
}

async function sourceHashes(): Promise<Record<string, string>> {
  const glob = new Bun.Glob("{server,lib,ui,build,benchmarks}/**/*.{ts,json}");
  const scanned = await Array.fromAsync(glob.scan(root));
  const paths = ["index.ts", "package.json", "bun.lock", ...scanned]
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !path.startsWith("benchmarks/results/"))
    .toSorted();
  return Object.fromEntries(
    await sequential(
      paths,
      async (path) =>
        [path, sha256(await Bun.file(resolve(root, path)).text())] as const,
    ),
  );
}

async function report(evidence: Evidence, rows: readonly Row[]): Promise<void> {
  await evidence.json("summary.json", rows);
  const table = rows.map(
    (row) =>
      `| ${String(row.id)} | ${String(row.status)} | ${String(row.completedStages ?? "—")} | ${String(row.predictions ?? "—")} | ${typeof row.costUsd === "number" ? `$${row.costUsd.toFixed(2)}` : "—"} |`,
  );
  await evidence.text(
    "summary.md",
    `# Benchmark attempts\n\nQuality scores require human review; completion is not a quality score.\n\n| Trial | Status | Stages | Predictions | Cost |\n|---|---|---:|---:|---:|\n${table.join("\n")}\n`,
  );
}

/**
 * Checks every selected model up front: Replicate models resolve their schema, CLI
 * models check the CLI (and Ollama model) is installed. Unavailable models are
 * recorded and their trials skipped.
 */
async function resolveModels(
  provider: ReplicateProvider | undefined,
  { suite, evidence }: ILiveRun,
  signal: AbortSignal,
): Promise<Map<string, Resolution | string>> {
  const resolveOne = async (
    model: Suite["models"][number],
  ): Promise<Resolution> => {
    if (isCliModel(model)) return preflightCli(model);
    if (!provider)
      throw new Error("Replicate models need REPLICATE_API_TOKEN.");
    return provider.resolve(model, suite.limits.outputTokens);
  };
  const resolutions = await sequential(
    suite.models,
    async (model): Promise<[string, Resolution | string]> => {
      signal.throwIfAborted();
      try {
        const metadata = await resolveOne(model);
        await evidence.json(`models/${model.id}.json`, metadata);
        return [model.id, metadata];
      } catch (error) {
        await evidence.json(`models/${model.id}.json`, {
          status: "unavailable",
          error: errorText(error),
        });
        return [model.id, errorText(error)];
      }
    },
  );
  return new Map(resolutions);
}

/** Stops the whole run after a trial whose outcome makes continuing unsafe or pointless. */
function stopIfUnsafe(trialId: string, status: string): void {
  if (status === "rate-limited") {
    throw new Error(
      `Rate or usage limit persisted during ${trialId}; remaining trials were not started. Wait for the limit to reset (or raise Replicate credit above $20), then rerun.`,
    );
  }
  if (status === "cost-capped") {
    throw new Error(
      `Cost cap reached during ${trialId}; remaining trials were not started.`,
    );
  }
  if (status === "infrastructure-error") {
    throw new Error(
      `Infrastructure state uncertain after ${trialId}. Stopped; inspect the recorded error, Blockbench and the model service before another run.`,
    );
  }
}

/** Runs the matrix one trial at a time, holding the machine lock and stopping on uncertain infrastructure. */
async function runLive(live: ILiveRun): Promise<void> {
  const {
    suite,
    trials,
    context,
    evidence,
    directory,
    endpoint,
    token,
    ledger,
    runId,
  } = live;
  const release = acquireLock();
  const controller = new AbortController();
  const interrupt = (): void =>
    controller.abort(new Error("Interrupted by operator."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let rows: readonly Row[] = trials.map((trial) => ({
    id: trial.id,
    status: "pending",
  }));
  const record = async (index: number, row: Row): Promise<void> => {
    rows = rows.with(index, row);
    await report(evidence, rows);
    await evidence.json("costs.json", ledger.snapshot());
  };
  try {
    const provider = token
      ? new ReplicateProvider(token, fetch, {
          minRequestIntervalMs: suite.limits.minRequestIntervalMs,
        })
      : undefined;
    const models = await resolveModels(provider, live, controller.signal);
    const codexServers = suite.models.some((model) => model.runner === "codex")
      ? await codexMcpServers()
      : [];
    await report(evidence, rows);
    await sequential(trials, async (trial, index) => {
      controller.signal.throwIfAborted();
      const model = models.get(trial.model.id);
      if (typeof model !== "object") {
        await record(index, {
          id: trial.id,
          status: "skipped-unavailable",
          reason: model,
        });
        return;
      }
      console.log(
        `[${index + 1}/${trials.length}] ${trial.id} (spent $${ledger.spentUsd.toFixed(2)})`,
      );
      const shared = {
        context,
        evidence: new Evidence(
          resolve(directory, "trials", trial.id),
          token ? [token] : [],
        ),
        limits: suite.limits,
        signal: controller.signal,
        connect: () => connect(endpoint, trial.id),
      };
      if (isCliModel(trial.model)) {
        // Local CLIs bill a subscription or nothing; tokens are recorded, not priced.
        const factory = cliAgentFactory(
          trial.model,
          runId,
          trial.id,
          codexServers,
        );
        const agents: CliAgent[] = [];
        const result = await runTrial(trial, {
          ...shared,
          createAgent: async (setup) => {
            const agent = await factory(setup);
            agents.push(agent);
            return agent;
          },
        });
        const usage = agents[0]?.usage;
        await record(index, {
          ...result,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          costUsd: null,
        });
        stopIfUnsafe(trial.id, result.status);
        return;
      }
      if (!provider || !("schemaVersion" in model)) {
        throw new Error(`No Replicate client for ${trial.id}.`);
      }
      const before = ledger.spendFor(trial.model);
      const result = await runTrial(trial, {
        ...shared,
        predict: (prompt, destination, signal) =>
          ledger.charge(trial.model, prompt, () =>
            provider.predict(model, prompt, suite.limits, destination, signal),
          ),
      });
      const after = ledger.spendFor(trial.model);
      await record(index, {
        ...result,
        inputTokens: (after?.inputTokens ?? 0) - (before?.inputTokens ?? 0),
        outputTokens: (after?.outputTokens ?? 0) - (before?.outputTokens ?? 0),
        costUsd:
          typeof after?.costUsd === "number" &&
          typeof before?.costUsd === "number"
            ? after.costUsd - before.costUsd
            : null,
      });
      stopIfUnsafe(trial.id, result.status);
    });
  } catch (error) {
    await evidence.event("run-stopped", { error: errorText(error) });
    rows = rows.map((row) =>
      row.status === "pending" ? { ...row, status: "not-run-after-stop" } : row,
    );
    await report(evidence, rows);
    await evidence.json("costs.json", ledger.snapshot());
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    release();
  }
  if (rows.some((row) => row.status !== "completed")) process.exitCode = 1;
}

/** Runs a reproducible offline plan or an explicitly requested sequential live matrix. */
export async function main(args = Bun.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: cliOptions,
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const command = positionals[0] ?? "plan";
  if (positionals.length > 1 || !isCommand(command))
    throw new Error("Use plan or run. See --help.");
  const suite = await loadSuite(values);
  const projectRoot = resolve(
    values["project-root"] ??
      Bun.env.BLOCKBENCH_PROJECT_ROOT ??
      resolve(root, "../blockbench-mcp-project/blockbench-mcp-project"),
  );
  const context = await loadContext(projectRoot);
  const trials = matrix(suite);
  const endpoint = mcpEndpoint();
  const token = liveToken(command, suite);
  const capUsd = maxCost(values["max-cost"], suite);
  // Checks pricing coverage for a capped run before any results directory is written.
  // Only Replicate models are billed per token; local CLIs are left out of the cap.
  const ledger = new CostLedger(
    suite.models.filter((model) => !isCliModel(model)),
    suite.limits,
    command === "run" ? capUsd : undefined,
  );
  const ceilings = projectCeilings(suite, trials);
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}--${command}--${crypto.randomUUID().slice(0, 8)}`;
  const directory = resolve(import.meta.dir, "results", runId);
  const secret = Bun.env.REPLICATE_API_TOKEN;
  const evidence = new Evidence(directory, secret ? [secret] : []);
  await evidence.json("manifest.json", {
    version: 1,
    runId,
    command,
    createdAt: new Date().toISOString(),
    bun: Bun.version,
    platform: process.platform,
    endpoint,
    suite,
    sourceHashes: await sourceHashes(),
    contextHashes: context.hashes,
    track: "text-observation/dedicated-tools",
    qualityScores: "human review required",
    versionPolicy:
      "Explicit versions are pinned; community aliases pin resolved versions. Official aliases can drift; prediction versions are recorded.",
  });
  await evidence.json("context.json", context);
  await evidence.json("cost-projection.json", {
    basis:
      "worst case: every prediction at the context-character cap and output-token cap",
    capUsd: capUsd ?? null,
    ceilings,
  });
  await evidence.json(
    "plan.json",
    trials.map((trial) => ({ ...trial, prompts: prompts(trial) })),
  );
  console.log(
    `${command}: ${trials.length} sequential trials; at most ${trials.length * suite.limits.predictionsPerTrial} predictions. Results: ${directory}`,
  );
  console.log(formatCeilings(ceilings, suite, capUsd));
  if (command === "plan") {
    await evidence.text(
      "README.md",
      "# Offline benchmark plan\n\nNo Replicate inference or Blockbench connection was made. This is configuration evidence, not model-quality data.\n",
    );
    return;
  }
  await runLive({
    suite,
    trials,
    context,
    evidence,
    directory,
    endpoint,
    token,
    ledger,
    runId,
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      redact(errorText(error), [Bun.env.REPLICATE_API_TOKEN ?? ""]),
    );
    process.exitCode = 1;
  }
}
