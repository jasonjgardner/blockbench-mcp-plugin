import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Suite } from "./config";
import type { IContext } from "./context";
import { CostCapReached } from "./cost";
import { RateLimited } from "./ratelimit";
import { type Evidence, errorText } from "./evidence";
import { assertSafeCall } from "./policy";
import { allowedTool, type IMcp, projectUri } from "./mcp";
import {
  type Action,
  boundedObservation,
  protocol,
  safeParseAction,
} from "./protocol";
import { PredictionUncertain } from "./replicate";

/** Infrastructure failure whose unresolved MCP state requires stopping the whole run. */
export class McpFailure extends Error {}
/** Shared-budget exhaustion, distinct from completed stages and infrastructure errors. */
export class BudgetFailure extends Error {}

/** Wraps MCP transport work so any failure is reported as unresolved infrastructure state. */
export async function asMcpFailure<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new McpFailure(errorText(error));
  }
}

/** Dependency-injected modeling session; the same predictor and tool policy serve all providers. */
export interface IAgentOptions {
  mcp: IMcp;
  /** Tools listed at the start of the trial; refreshed from `mcp` before every turn. */
  tools: Tool[];
  context: IContext;
  evidence: Evidence;
  limits: Suite["limits"];
  project: string;
  view: string;
  signal: AbortSignal;
  predict: (prompt: string) => Promise<string>;
}

/** One entry in a primary or advisor conversation transcript. */
interface IMessage {
  role: string;
  content: string;
}

/** Result of handling one model reply: either the stage summary or the next observation. */
type Turn =
  { done: true; summary: string } | { done: false; observation: string };
type ToolAction = Extract<Action, { action: "describe_tool" | "call_tool" }>;

/** Failures that must end the trial rather than be shown to the model as an observation. */
const fatalErrors = [
  McpFailure,
  BudgetFailure,
  PredictionUncertain,
  CostCapReached,
  RateLimited,
] as const;
/** Upper bound on advisory reviews per trial, shared across stages. */
const maxDelegations = 2;
const reviewerNotice =
  "You are an advisory subagent. Only read-only inspection tools are available. No nested delegation, web browsing, vision or offscreen camera control. State these limitations; do not invent research or visual observations.";

/** Sequential agent controller with strict action parsing, shared budgets and isolated advisor histories. */
export class Agent {
  predictions = 0;
  toolCalls = 0;
  toolErrors = 0;
  protocolErrors = 0;
  delegations = 0;
  private readonly history: IMessage[] = [];
  // Blockbench enables and disables tools as its project, mode, format and selection
  // change, so the list the model sees must be re-read rather than fixed at startup.
  private tools: readonly Tool[];

  /** Options provide only this trial's client, snapshot and predictor; no host shell is exposed. */
  constructor(private readonly options: IAgentOptions) {
    this.tools = options.tools;
  }

  /** Runs one stage to a done action; budget exhaustion never counts as completion. */
  async stage(prompt: string): Promise<string> {
    this.history.push({ role: "user", content: prompt });
    return this.turns(this.history, this.options.limits.turnsPerStage, false);
  }

  private system(reviewer: boolean): string {
    const { context, project, view } = this.options;
    const bootstrap = ["AGENTS.md", "skills/blockbench-use/SKILL.md"]
      .map((path) => `${path}\n${context.files[path]}`)
      .join("\n\n");
    // Names only: descriptions for ~140 tools would add ~33k characters to every
    // prediction. describe_tool returns a tool's description and schema on demand.
    const visibleTools = this.tools
      .filter((tool) => allowedTool(tool, reviewer))
      .map(({ name }) => name);
    return [
      protocol,
      bootstrap,
      `Assigned project: ${project}`,
      `Use view=${view} for screenshots and camera calls.`,
      `Available context paths: ${JSON.stringify(Object.keys(context.files))}`,
      `Available advisory subagents: ${JSON.stringify(Object.keys(context.agents))}`,
      `Tool names (use describe_tool for a tool's description and schema): ${JSON.stringify(visibleTools)}`,
      reviewer ? reviewerNotice : "",
    ].join("\n");
  }

  private async turns(
    history: IMessage[],
    remaining: number,
    reviewer: boolean,
  ): Promise<string> {
    const { limits, signal, predict } = this.options;
    signal.throwIfAborted();
    if (remaining <= 0 || this.predictions >= limits.predictionsPerTrial) {
      throw new BudgetFailure("Agent prediction/turn budget exhausted.");
    }
    await this.refreshTools();
    const prompt = `${this.system(reviewer)}\nConversation (JSON):\n${JSON.stringify(history)}\nReturn the next single JSON action.`;
    if (prompt.length > limits.contextCharacters) {
      throw new BudgetFailure(
        "Common context-character budget exhausted; no silent history truncation.",
      );
    }
    this.predictions += 1;
    const text = await predict(prompt);
    history.push({ role: "assistant", content: text });
    const turn = await this.respond(text, reviewer);
    if (turn.done) return turn.summary;
    history.push({ role: "observation", content: turn.observation });
    return this.turns(history, remaining - 1, reviewer);
  }

  /** Parses and executes one reply; recoverable mistakes become observations for the next turn. */
  private async respond(text: string, reviewer: boolean): Promise<Turn> {
    const { evidence, limits, signal } = this.options;
    const parsed = safeParseAction(text);
    if (!parsed.success) {
      this.protocolErrors += 1;
      await evidence.event("protocol-error", {
        reviewer,
        error: parsed.error,
        output: text,
      });
      return {
        done: false,
        observation: `Invalid action: ${parsed.error}. Return exactly one valid JSON action.`,
      };
    }
    const { action } = parsed;
    await evidence.event("agent-action", { reviewer, action });
    if (action.action === "done")
      return { done: true, summary: action.summary };
    try {
      const result = await this.execute(action, reviewer);
      return {
        done: false,
        observation: boundedObservation(result, limits.observationCharacters),
      };
    } catch (error) {
      if (signal.aborted || fatalErrors.some((type) => error instanceof type))
        throw error;
      await evidence.event("action-error", {
        reviewer,
        error: errorText(error),
      });
      return { done: false, observation: errorText(error) };
    }
  }

  private async execute(
    action: Exclude<Action, { action: "done" }>,
    reviewer: boolean,
  ): Promise<unknown> {
    if (action.action === "read_context") return this.readContext(action.path);
    if (action.action === "delegate")
      return this.delegate(action.agent, action.task, reviewer);
    if (action.action === "read_resource")
      return this.readResource(action.uri, reviewer);
    return this.useTool(action, reviewer);
  }

  private readContext(path: string): string | undefined {
    const { files } = this.options.context;
    if (!Object.hasOwn(files, path))
      throw new Error(
        "Unknown context path; only snapshotted files are readable.",
      );
    return files[path];
  }

  private async delegate(
    agent: string,
    task: string,
    reviewer: boolean,
  ): Promise<string> {
    const { context, evidence, project, limits } = this.options;
    if (
      reviewer ||
      this.delegations >= maxDelegations ||
      !Object.hasOwn(context.agents, agent)
    ) {
      throw new Error(
        "Subagent unavailable, nested, or two-review limit reached.",
      );
    }
    this.delegations += 1;
    const brief = `${context.agents[agent]}\nTask: ${task}\nAssigned project: ${project}`;
    const response = await this.turns(
      [{ role: "user", content: brief }],
      limits.reviewerTurns,
      true,
    );
    await evidence.event("subagent-result", { agent, response });
    return response;
  }

  private async readResource(uri: string, reviewer: boolean): Promise<unknown> {
    const { mcp, evidence, project } = this.options;
    // Only the assigned project file: resource discovery for other open projects is excluded.
    if (reviewer || uri !== project) {
      throw new Error(
        "Only the assigned project resource is available to the primary agent.",
      );
    }
    await this.assertProject();
    return asMcpFailure(async () => {
      const result = await evidence.materialize(await mcp.read(uri));
      await evidence.event("resource-result", { uri, result });
      return result;
    });
  }

  /** Re-reads the live tool list and records which tools appeared or disappeared. */
  private async refreshTools(): Promise<void> {
    const { mcp, evidence } = this.options;
    const current = await asMcpFailure(() => mcp.tools());
    const before = new Set(this.tools.map((tool) => tool.name));
    const after = new Set(current.map((tool) => tool.name));
    const added = [...after].filter((name) => !before.has(name));
    const removed = [...before].filter((name) => !after.has(name));
    this.tools = current;
    if (added.length || removed.length) {
      await evidence.event("tools-changed", { added, removed });
    }
  }

  private async useTool(
    action: ToolAction,
    reviewer: boolean,
  ): Promise<unknown> {
    const { mcp, evidence, view } = this.options;
    const tool = this.tools.find((item) => item.name === action.name);
    if (!tool) {
      throw new Error(
        "Tool is not currently available. Blockbench hides tools whose project, mode, format or selection requirements are unmet; use a tool from this turn's list (for example, switch mode first).",
      );
    }
    if (!allowedTool(tool, reviewer)) {
      throw new Error("Tool is not available under this track's policy.");
    }
    if (action.action === "describe_tool") return tool;
    assertSafeCall(action.name, action.arguments, view);
    await this.assertProject();
    this.toolCalls += 1;
    const result = await asMcpFailure(async () => {
      const response = await mcp.call(action.name, action.arguments);
      if (response.isError) this.toolErrors += 1;
      return evidence.materialize(response);
    });
    await evidence.event("tool-result", { name: action.name, result });
    await this.assertProject();
    return result;
  }

  private async assertProject(): Promise<void> {
    const { mcp, project, signal } = this.options;
    signal.throwIfAborted();
    await asMcpFailure(async () => {
      const result = await mcp.call("get_project_info");
      if (result.isError || projectUri(result) !== project) {
        throw new Error(
          "Active project changed; benchmark stopped to prevent contamination.",
        );
      }
    });
  }
}
