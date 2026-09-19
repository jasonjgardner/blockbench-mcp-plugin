import { $ } from "bun";
import { resolve } from "node:path";
import { BudgetFailure } from "./agent";
import type { Model, Suite } from "./config";
import type { IContext } from "./context";
import { type Evidence, errorText } from "./evidence";
import type { PolicyProxy } from "./proxy";
import { guidanceTool } from "./proxy";
import { RateLimited } from "./ratelimit";
import { type ICliRunner, type ICliUsage, proxyServerName } from "./runners";

/** Output that means the CLI's account or local quota refused the run, not a model failure. */
const quotaPattern =
  /rate.?limit|usage limit|quota|too many requests|\b429\b|resource.?exhausted/i;

/** Stage protocol for CLI agents, which call tools natively instead of emitting JSON actions. */
const cliProtocol = `You are the modeling agent in a controlled Blockbench quality benchmark.
Work only through the "${proxyServerName}" MCP tools. You have no shell, file, web or
image tools; do not ask for them. The harness already created your project. Work only
on that project; do not create, switch, close, import or rename projects. Arbitrary
JavaScript, generic UI actions, file access and settings changes are unavailable.
Exports must return content, never write a path. Read tool schemas before calling
tools; tool failures are observations to fix or report. Use ${guidanceTool} to read
the Blockbench skills and references listed in its description.
This is a text-observation track: screenshots are archived for human reviewers, not
shown to you. Do not claim to have seen an image. Inspect geometry, UVs and animation
data with tools; capture screenshots as evidence.
No human is present; do not ask questions. Each stage has a time limit, and may have
a tool-call budget: if a tool reports the budget is used up, stop and summarize.
Finish only the current stage and end with a short summary of verified outcomes and
remaining limitations.`;

/** Everything one CLI agent needs for a trial. */
export interface ICliAgentOptions {
  runner: ICliRunner;
  model: Model;
  proxy: PolicyProxy;
  evidence: Evidence;
  context: IContext;
  limits: Suite["limits"];
  signal: AbortSignal;
  project: string;
  view: string;
  /** Empty scratch folder for this trial, outside any repository. */
  workdir: string;
  /** MCP server names from the operator's Codex config, switched off for the run. */
  codexServers: readonly string[];
}

/** Kills a process and, on Windows, its children (a `.cmd` shim's node process survives a plain kill). */
async function killTree(proc: Bun.Subprocess): Promise<void> {
  if (process.platform === "win32") {
    await $`taskkill /T /F /PID ${proc.pid}`.quiet().nothrow();
    return;
  }
  proc.kill();
}

/**
 * Drives one agent CLI through the benchmark stages, continuing a single session.
 * Presents the same counters as the harness's own agent loop: each CLI run counts
 * as one prediction, and tool counts come from the proxy.
 */
export class CliAgent {
  predictions = 0;
  readonly protocolErrors = 0;
  readonly delegations = 0;
  /** Token counts summed across stages; undefined when the CLI never reported them. */
  usage: ICliUsage = { inputTokens: undefined, outputTokens: undefined };
  private session: string | undefined;
  private stages = 0;
  private readonly newSession = crypto.randomUUID();

  constructor(private readonly options: ICliAgentOptions) {}

  get toolCalls(): number {
    return this.options.proxy.toolCalls;
  }

  get toolErrors(): number {
    return this.options.proxy.toolErrors;
  }

  /** Stops the proxy; the trial's own MCP connection is closed separately. */
  async close(): Promise<void> {
    await this.options.proxy.close();
  }

  /** Runs one stage; running out of tool calls or time never counts as completion. */
  async stage(prompt: string): Promise<string> {
    const { runner, model, proxy, evidence, limits, signal, workdir } =
      this.options;
    signal.throwIfAborted();
    this.stages += 1;
    const number = this.stages;
    proxy.beginStage(limits.toolCallsPerStage || Number.POSITIVE_INFINITY);
    const stage = {
      model,
      proxyUrl: proxy.url,
      workdir,
      session: this.session,
      newSession: this.newSession,
      codexServers: this.options.codexServers,
    };
    const command = runner.command(stage);
    await Promise.all(
      Object.entries(command.files).map(([name, text]) =>
        Bun.write(resolve(workdir, name), text),
      ),
    );
    const input = number === 1 ? this.firstPrompt(prompt) : prompt;
    await evidence.event("cli-start", {
      stage: number,
      cmd: command.cmd,
      env: Object.keys(command.env),
    });
    const timeout = AbortSignal.timeout(limits.stageTimeoutMs);
    const stop = AbortSignal.any([signal, proxy.fatalSignal, timeout]);
    const started = Date.now();
    const proc = Bun.spawn(command.cmd, {
      cwd: workdir,
      env: { ...Bun.env, ...command.env },
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const onStop = (): void => void killTree(proc);
    stop.addEventListener("abort", onStop, { once: true });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => stop.removeEventListener("abort", onStop));
    this.predictions += 1;
    await evidence.text(`cli/stage-${number}.stdout`, stdout);
    await evidence.text(`cli/stage-${number}.stderr`, stderr);
    await evidence.event("cli-exit", {
      stage: number,
      exitCode,
      durationMs: Date.now() - started,
    });
    if (proxy.fatal) throw proxy.fatal;
    signal.throwIfAborted();
    if (timeout.aborted) {
      throw new BudgetFailure(
        `Stage ${number} reached its ${limits.stageTimeoutMs} ms time limit.`,
      );
    }
    const outcome = this.outcome(stdout, stderr, exitCode, stage);
    this.session = outcome.session;
    this.usage = {
      inputTokens: add(this.usage.inputTokens, outcome.usage.inputTokens),
      outputTokens: add(this.usage.outputTokens, outcome.usage.outputTokens),
    };
    await evidence.event("cli-result", {
      stage: number,
      summary: outcome.summary,
      usage: outcome.usage,
      reportedModel: outcome.reportedModel,
    });
    if (proxy.stageExhausted) {
      throw new BudgetFailure(
        `Stage ${number} used its ${limits.toolCallsPerStage}-call tool budget.`,
      );
    }
    return outcome.summary;
  }

  /** Stage one carries the protocol, bootstrap guidance and assignment. */
  private firstPrompt(prompt: string): string {
    const { context, project, view } = this.options;
    const bootstrap = ["AGENTS.md", "skills/blockbench-use/SKILL.md"]
      .map((path) => `${path}\n${context.files[path]}`)
      .join("\n\n");
    return [
      cliProtocol,
      bootstrap,
      `Assigned project: ${project}`,
      `Use view=${view} for screenshots and camera calls.`,
      prompt,
    ].join("\n\n");
  }

  /** Parses a finished run, telling quota refusals apart from other failures. */
  private outcome(
    stdout: string,
    stderr: string,
    exitCode: number,
    stage: Parameters<ICliRunner["parse"]>[1],
  ): ReturnType<ICliRunner["parse"]> {
    try {
      // Some CLIs (Gemini) print their JSON error report to stderr with stdout empty.
      const outcome = this.options.runner.parse(
        stdout.trim() ? stdout : stderr,
        stage,
      );
      if (exitCode !== 0) throw new Error(`exited ${exitCode}`);
      return outcome;
    } catch (error) {
      const detail = `${errorText(error)} | ${stderr.trim().slice(-500)}`;
      if (quotaPattern.test(`${detail} ${stdout.slice(-1000)}`)) {
        throw new RateLimited(`CLI quota or rate limit: ${detail}`);
      }
      throw new Error(`CLI run failed: ${detail}`);
    }
  }
}

/** Adds two optional counts. */
function add(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}
