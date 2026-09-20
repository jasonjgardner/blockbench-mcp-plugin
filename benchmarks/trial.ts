import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Agent, asMcpFailure, BudgetFailure, McpFailure } from "./agent";
import { type IModelMetrics, measureModel, reviewTemplate } from "./assessment";
import { type ITrial, sequential, type Suite } from "./config";
import type { IContext } from "./context";
import { CostCapReached } from "./cost";
import { caught, Evidence, errorText } from "./evidence";
import { type IMcp, projectUri } from "./mcp";
import { prompts } from "./prompts";
import { RateLimited } from "./ratelimit";
import { PredictionUncertain } from "./replicate";

/** Offscreen view reserved for harness evidence; the agent may only aim and capture it. */
const view = "benchmark_evidence";
/**
 * Harness tools that must be listed before any project exists. The plugin hides
 * project-dependent tools until a project is open, so those are checked later.
 */
const setupTools = [
  "get_capabilities",
  "create_project",
  "create_offscreen_view",
  "delete_offscreen_view",
] as const;
/** Harness tools that only become available once the project and evidence view exist. */
const projectTools = [
  "get_project_info",
  "set_camera_angle",
  "capture_screenshot",
] as const;
/** Displacement applied to the second fixture cube under the "repair" condition. */
const repairOffset = [6, 4, 0] as const;
const cameraPosition = [48, 36, 48] as const;
const orthographicAngles = ["north", "east", "top"] as const;
const animationFractions = [0, 0.25, 0.5, 0.75, 1] as const;
const resourceSchema = z.object({
  contents: z.array(
    z.object({ uri: z.string(), text: z.string() }).passthrough(),
  ),
});

/** What the harness has prepared when it hands a trial to an agent. */
export interface IAgentSetup {
  mcp: IMcp;
  /** Tools available once the project and evidence view exist. */
  tools: Tool[];
  context: IContext;
  evidence: Evidence;
  limits: Suite["limits"];
  project: string;
  view: string;
  signal: AbortSignal;
}

/**
 * Anything that can work through the stages: the harness's own JSON-action loop
 * over a text predictor, or an agent CLI behind the policy proxy.
 */
export interface IStageAgent {
  stage(prompt: string): Promise<string>;
  readonly predictions: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly protocolErrors: number;
  readonly delegations: number;
  /** Releases agent-owned resources such as the proxy; runs during teardown. */
  close?(): Promise<void>;
}

/**
 * Trial execution dependencies allow offline simulation without a real model or
 * Blockbench. Supply `createAgent` for an agent CLI, or `predict` to run the
 * harness's own loop over a text predictor.
 */
export interface ITrialDependencies {
  connect: () => Promise<IMcp>;
  predict?: (
    prompt: string,
    evidence: Evidence,
    signal: AbortSignal,
  ) => Promise<string>;
  createAgent?: (setup: IAgentSetup) => Promise<IStageAgent>;
  context: IContext;
  evidence: Evidence;
  limits: Suite["limits"];
  signal: AbortSignal;
}

/** Builds the agent for a trial from whichever dependency was supplied. */
async function createStageAgent(
  dependencies: ITrialDependencies,
  setup: IAgentSetup,
): Promise<IStageAgent> {
  if (dependencies.createAgent) return dependencies.createAgent(setup);
  const { predict } = dependencies;
  if (!predict) throw new Error("A trial needs either createAgent or predict.");
  return new Agent({
    ...setup,
    predict: (prompt) => predict(prompt, setup.evidence, setup.signal),
  });
}

/** Distinguishes agent completion from quality, missing evidence and an unsafe-to-continue MCP failure. */
export interface ITrialResult {
  id: string;
  status:
    | "completed"
    | "budget-exhausted"
    | "cost-capped"
    | "rate-limited"
    | "failed"
    | "infrastructure-error";
  completedStages: number;
  predictions: number;
  toolCalls: number;
  toolErrors: number;
  protocolErrors: number;
  delegations: number;
  durationMs: number;
  evidenceErrors: string[];
  error: string | null;
  qualityScore: null;
}

type Status = ITrialResult["status"];

/** A connected MCP client paired with the trial's evidence sink. */
interface ISession {
  mcp: IMcp;
  evidence: Evidence;
}

/** Lifecycle facts gathered while a trial runs, so teardown knows exactly what to undo. */
interface IProgress {
  session?: ISession;
  project?: string;
  agent?: IStageAgent;
  viewCreated: boolean;
  completedStages: number;
}

/**
 * Lists the tools available in the current editor state, archives the list, and
 * fails if any tool the harness needs next is hidden.
 */
async function requireTools(
  { mcp, evidence }: ISession,
  names: readonly string[],
  path: string,
): Promise<Tool[]> {
  const tools = await asMcpFailure(() => mcp.tools());
  await evidence.json(path, tools);
  const missing = names.filter(
    (name) => !tools.some((tool) => tool.name === name),
  );
  if (missing.length) {
    throw new Error(`Required MCP tools unavailable: ${missing.join(", ")}`);
  }
  return tools;
}

/** Calls an MCP tool on the harness's behalf, logging it and treating tool errors as failures. */
async function harnessCall(
  { mcp, evidence }: ISession,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  await evidence.event("harness-tool-request", { name, arguments: args });
  const response = await asMcpFailure(() => mcp.call(name, args));
  await evidence.event("harness-tool-result", {
    name,
    result: await evidence.materialize(response),
  });
  if (response.isError) {
    const detail = response.content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join(" ");
    throw new Error(
      `${name} returned an MCP tool error: ${detail || "(no message)"}`,
    );
  }
  return response;
}

/** Saves the live project and its structural metrics, after confirming it still belongs to this trial. */
async function snapshot(
  session: ISession,
  project: string,
  name: string,
): Promise<IModelMetrics> {
  if (projectUri(await harnessCall(session, "get_project_info")) !== project) {
    throw new McpFailure("Active project no longer belongs to this trial.");
  }
  const raw = await asMcpFailure(() => session.mcp.read(project));
  const content = resourceSchema
    .parse(raw)
    .contents.find((item) => item.uri === project)?.text;
  if (!content)
    throw new Error("Project resource returned no complete JSON content.");
  const metrics = measureModel(JSON.parse(content) as unknown);
  await session.evidence.text(`${name}.bbmodel`, content);
  await session.evidence.json(`${name}-structure.json`, metrics);
  return metrics;
}

/** Fixture cubes for the trial's condition; "repair" displaces the second cube. */
function fixtureElements(
  trial: ITrial,
): { name: string; from: number[]; to: number[] }[] {
  const shift = (point: readonly number[]): number[] =>
    point.map((value, axis) => value + (repairOffset[axis] ?? 0));
  return trial.asset.fixture.map((cube, index) =>
    trial.condition === "repair" && index === 1
      ? { ...cube, from: shift(cube.from), to: shift(cube.to) }
      : cube,
  );
}

/** Captures one screenshot of the evidence view and archives it under `views/`. */
async function captureView(session: ISession, name: string): Promise<void> {
  const screenshot = await harnessCall(session, "capture_screenshot", { view });
  await session.evidence.json(
    `views/${name}.json`,
    await session.evidence.materialize(screenshot),
  );
}

/** Standardized orthographic, perspective and animation-pose screenshots for human review. */
async function captureViews(
  session: ISession,
  trial: ITrial,
  metrics: IModelMetrics,
): Promise<void> {
  const target = trial.asset.format === "java_block" ? [8, 8, 8] : [0, 12, 0];
  const camera = { view, position: cameraPosition, target };
  await sequential(orthographicAngles, async (angle) => {
    await harnessCall(session, "set_camera_angle", {
      ...camera,
      projection: "orthographic",
      locked_angle: angle,
    });
    await captureView(session, angle);
  });
  await harnessCall(session, "set_camera_angle", {
    ...camera,
    projection: "perspective",
  });
  await captureView(session, "perspective");
  await sequential(metrics.animations, async (animation, index) => {
    const timeline = (
      action: string,
      extra: Record<string, unknown> = {},
    ): Promise<CallToolResult> =>
      harnessCall(session, "animation_timeline", {
        action,
        animation_id: animation.id,
        ...extra,
      });
    await timeline("pause");
    await sequential(animationFractions, async (fraction) => {
      await timeline("set_time", { time: animation.length * fraction });
      await captureView(session, `animation-${index}-${fraction}`);
    });
    await timeline("stop");
  });
}

/** Connects, prepares the project and fixture, then drives the agent through every stage. */
async function execute(
  trial: ITrial,
  dependencies: ITrialDependencies,
  signal: AbortSignal,
  stagePrompts: readonly string[],
  progress: IProgress,
): Promise<void> {
  const { evidence, context, limits } = dependencies;
  signal.throwIfAborted();
  const mcp = await asMcpFailure(dependencies.connect);
  const session: ISession = { mcp, evidence };
  progress.session = session;
  await requireTools(session, setupTools, "tools.json");
  await evidence.json(
    "capabilities-before.json",
    await harnessCall(session, "get_capabilities", { include_tools: true }),
  );
  const project = projectUri(
    await harnessCall(session, "create_project", {
      name: `benchmark-${trial.id}`,
      format: trial.asset.format,
    }),
  );
  progress.project = project;
  // place_cube is hidden until a project is open, so check it only after creation.
  if (trial.condition !== "empty") {
    await requireTools(session, ["place_cube"], "tools-fixture.json");
    await harnessCall(session, "place_cube", {
      elements: fixtureElements(trial),
    });
  }
  await harnessCall(session, "create_offscreen_view", {
    id: view,
    width: 768,
    height: 768,
    copy_view: "none",
  });
  progress.viewCreated = true;
  const tools = await requireTools(session, projectTools, "tools-project.json");
  await harnessCall(session, "set_camera_angle", {
    view,
    position: cameraPosition,
    target: [0, 12, 0],
    projection: "perspective",
  });
  await snapshot(session, project, "initial");
  const agent = await createStageAgent(dependencies, {
    mcp,
    tools,
    context,
    evidence,
    limits,
    project,
    view,
    signal,
  });
  progress.agent = agent;
  await sequential(stagePrompts, async (prompt, index) => {
    const summary = await agent.stage(prompt);
    progress.completedStages += 1;
    await evidence.json(`stages/${index + 1}.json`, { prompt, summary });
    await snapshot(session, project, `stages/${index + 1}`);
  });
}

/** Classifies why a trial stopped; only infrastructure errors halt the whole matrix. */
function failureStatus(error: unknown): Status {
  if (error instanceof McpFailure || error instanceof PredictionUncertain)
    return "infrastructure-error";
  if (error instanceof BudgetFailure) return "budget-exhausted";
  if (error instanceof CostCapReached) return "cost-capped";
  if (error instanceof RateLimited) return "rate-limited";
  return "failed";
}

/** Final status after teardown: cleanup failures can downgrade, but never upgrade, the outcome. */
function settledStatus(
  status: Status,
  capture: { error: unknown } | undefined,
  teardownFailed: boolean,
): Status {
  if (teardownFailed || capture?.error instanceof McpFailure)
    return "infrastructure-error";
  if (capture && status === "completed") return "failed";
  return status;
}

/** Saves final evidence, removes the view and closes MCP; each step runs even if an earlier one fails. */
async function finalize(
  trial: ITrial,
  progress: IProgress,
  status: Status,
): Promise<Pick<ITrialResult, "status" | "evidenceErrors">> {
  const { session, project, viewCreated } = progress;
  if (!session) return { status, evidenceErrors: [] };
  const capture =
    project && status !== "infrastructure-error"
      ? await caught(async () => {
          const metrics = await snapshot(session, project, "final");
          if (viewCreated) await captureViews(session, trial, metrics);
        })
      : undefined;
  const removal = viewCreated
    ? await caught(() =>
        harnessCall(session, "delete_offscreen_view", { view }),
      )
    : undefined;
  const agentClosing = progress.agent?.close
    ? await caught(() => progress.agent?.close?.() ?? Promise.resolve())
    : undefined;
  const closing = await caught(() => session.mcp.close());
  const failures = [capture, removal, agentClosing, closing].filter(
    (failure) => failure !== undefined,
  );
  return {
    status: settledStatus(
      status,
      capture,
      removal !== undefined || closing !== undefined,
    ),
    evidenceErrors: failures.map(({ error }) => errorText(error)),
  };
}

/** Executes and closes exactly one MCP session, preserving partial artifacts on agent failure. */
export async function runTrial(
  trial: ITrial,
  dependencies: ITrialDependencies,
): Promise<ITrialResult> {
  const { evidence, context, limits } = dependencies;
  const start = Date.now();
  const signal = AbortSignal.any([
    dependencies.signal,
    AbortSignal.timeout(limits.trialTimeoutMs),
  ]);
  const stagePrompts = prompts(trial);
  const progress: IProgress = { viewCreated: false, completedStages: 0 };
  await evidence.json("trial.json", {
    trial,
    limits,
    prompts: stagePrompts,
    contextHashes: context.hashes,
  });
  await evidence.json("review.json", reviewTemplate(trial.asset));
  const failure = await caught(() =>
    execute(trial, dependencies, signal, stagePrompts, progress),
  );
  const status = failure ? failureStatus(failure.error) : "completed";
  const error = failure ? errorText(failure.error) : null;
  // A failed trace write must not skip teardown; it is rethrown after the session closes.
  const logFailure = failure
    ? await caught(() => evidence.event("trial-error", { status, error }))
    : undefined;
  const settled = await finalize(trial, progress, status);
  const { agent } = progress;
  const result: ITrialResult = {
    id: trial.id,
    status: settled.status,
    completedStages: progress.completedStages,
    predictions: agent?.predictions ?? 0,
    toolCalls: agent?.toolCalls ?? 0,
    toolErrors: agent?.toolErrors ?? 0,
    protocolErrors: agent?.protocolErrors ?? 0,
    delegations: agent?.delegations ?? 0,
    durationMs: Date.now() - start,
    evidenceErrors: settled.evidenceErrors,
    error,
    qualityScore: null,
  };
  await evidence.json("result.json", result);
  if (logFailure) throw logFailure.error;
  return result;
}
