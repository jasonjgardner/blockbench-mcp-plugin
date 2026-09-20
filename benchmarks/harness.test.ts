import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Agent, BudgetFailure } from "./agent";
import { measureModel, reviewTemplate } from "./assessment";
import { type Model, matrix, sequential, suiteSchema } from "./config";
import {
  CostCapReached,
  CostLedger,
  estimateTokens,
  projectCeilings,
  tokenCost,
} from "./cost";
import type { IContext } from "./context";
import { Evidence, redact } from "./evidence";
import { acquireLock, connect, type IMcp, projectUri } from "./mcp";
import { parseAction } from "./protocol";
import { prompts } from "./prompts";
import { reviewedScore } from "./report";
import {
  generationParameters,
  outputText,
  PredictionUncertain,
  ReplicateProvider,
  tokenUsage,
} from "./replicate";
import {
  maxThrottleAttempts,
  RateLimited,
  RequestSpacer,
  throttleDelayMs,
} from "./ratelimit";
import { runTrial } from "./trial";

const suite = suiteSchema.parse(
  await Bun.file(new URL("suite.json", import.meta.url)).json(),
);
const trial = matrix(suite)[0]!;
const context: IContext = {
  files: {
    "AGENTS.md": "Use MCP.",
    "skills/blockbench-use/SKILL.md": "Inspect first.",
  },
  hashes: {},
  agents: { reviewer: "Review structure without modifying anything." },
};
const uri = "blockbench://project/test-project.bbmodel";
const link: CallToolResult = {
  content: [{ type: "resource_link", name: "test.bbmodel", uri }],
};
const tool = (name: string, readOnlyHint = false): Tool => ({
  name,
  inputSchema: { type: "object" },
  annotations: { readOnlyHint },
});
const toolList = [
  "get_capabilities",
  "create_project",
  "get_project_info",
  "create_offscreen_view",
  "set_camera_angle",
  "capture_screenshot",
  "delete_offscreen_view",
  "place_cube",
].map((name) => tool(name));
// Bun.write creates directories on demand, so the unique root needs no up-front mkdtemp.
const temporary = join(tmpdir(), `blockbench-benchmark-${Bun.randomUUIDv7()}`);
let count = 0;
afterAll(async () => {
  const safeRoot = resolve(tmpdir());
  if (!resolve(temporary).startsWith(join(safeRoot, "blockbench-benchmark-")))
    throw new Error("Unsafe test cleanup path.");
  await rm(temporary, { recursive: true, force: true });
});
const evidence = (): Evidence =>
  new Evidence(join(temporary, String(++count)), ["test-secret"]);

function fakeMcp(): IMcp & { closed: boolean; calls: string[] } {
  return {
    closed: false,
    calls: [],
    tools: async () => toolList,
    async call(name) {
      this.calls.push(name);
      if (["create_project", "get_project_info"].includes(name)) return link;
      if (name === "capture_screenshot")
        return {
          content: [{ type: "image", mimeType: "image/png", data: "dGVzdA==" }],
        };
      return { content: [{ type: "text", text: "ok" }] };
    },
    read: async () => ({
      contents: [
        {
          uri,
          text: JSON.stringify({
            elements: [{ type: "cube", faces: { north: {} } }],
            textures: [],
            animations: [],
          }),
        },
      ],
    }),
    async close() {
      this.closed = true;
    },
  };
}

function fakeAgent(
  replies: string[],
  mcp: IMcp = fakeMcp(),
  overrides: Partial<ConstructorParameters<typeof Agent>[0]> = {},
): Agent {
  let index = 0;
  return new Agent({
    mcp,
    tools: [...toolList, tool("get_mesh_info", true)],
    context,
    evidence: evidence(),
    limits: suite.limits,
    project: uri,
    view: "benchmark_evidence",
    signal: new AbortController().signal,
    predict: async () =>
      replies[index++] ?? '{"action":"done","summary":"finished"}',
    ...overrides,
  });
}

describe("fair matrix and protocol", () => {
  test("covers all seven providers and crosses every case/condition/model equally", () => {
    expect(new Set(suite.models.map((model) => model.provider)).size).toBe(7);
    const cells = matrix(suite);
    expect(cells).toHaveLength(162);
    expect(new Set(cells.map((cell) => cell.id)).size).toBe(cells.length);
    suite.models.forEach((model) =>
      expect(cells.filter((cell) => cell.model.id === model.id)).toHaveLength(
        18,
      ),
    );
    suite.models.forEach((model) =>
      expect(prompts({ ...trial, model })).toEqual(prompts(trial)),
    );
    expect(() =>
      suiteSchema.parse({ ...suite, conditions: ["empty", "empty"] }),
    ).toThrow();
  });
  test("rejects malformed, extra-key and batched actions", () => {
    expect(
      parseAction('```json\n{"action":"done","summary":"ok"}\n```').action,
    ).toBe("done");
    expect(() =>
      parseAction('{"action":"done","summary":"ok","execute":"code"}'),
    ).toThrow();
    expect(() => parseAction('[{"action":"done","summary":"ok"}]')).toThrow();
  });
  test("awaits each task and stops on failure", async () => {
    let active = 0;
    let peak = 0;
    const visited: number[] = [];
    await expect(
      sequential([1, 2, 3], async (number) => {
        active += 1;
        peak = Math.max(peak, active);
        visited.push(number);
        await Bun.sleep(2);
        active -= 1;
        if (number === 2) throw new Error("stop");
        return number;
      }),
    ).rejects.toThrow("stop");
    expect(peak).toBe(1);
    expect(visited).toEqual([1, 2]);
  });
  test("machine lock rejects overlapping runners and releases", () => {
    const release = acquireLock(47393);
    try {
      expect(() => acquireLock(47393)).toThrow();
    } finally {
      release();
    }
    const releaseAgain = acquireLock(47393);
    releaseAgain();
  });
});

describe("Replicate adapter", () => {
  const schema = {
    components: {
      schemas: {
        Input: {
          properties: {
            prompt: { type: "string" },
            max_tokens: { type: "integer", maximum: 8192 },
            temperature: { type: "number", minimum: 0 },
          },
          required: ["prompt"],
        },
      },
    },
  };
  test("maps caps from actual schema and rejects incompatible endpoints", () => {
    expect(generationParameters(schema, 4096)).toEqual({
      max_tokens: 4096,
      temperature: 0,
    });
    expect(() => generationParameters(schema, 16384)).toThrow();
    expect(() => generationParameters({}, 4096)).toThrow();
    expect(outputText(["one", " two"])).toBe("one two");
    expect(() =>
      outputText({ generated_text: "no implicit adapter" }),
    ).toThrow();
  });
  test("maps OpenAI's max_completion_tokens cap", () => {
    // Shape of openai/gpt-5 and gpt-5-mini on Replicate: no temperature, no bounds.
    const openai = {
      components: {
        schemas: {
          Input: {
            properties: {
              prompt: { type: "string" },
              reasoning_effort: { default: "minimal" },
              max_completion_tokens: { type: "integer" },
            },
            required: [],
          },
        },
      },
    };
    expect(generationParameters(openai, 2048)).toEqual({
      max_completion_tokens: 2048,
    });
  });
  test("real SDK resolves schema and routes one prediction without network", async () => {
    const requests: { path: string; method: string; body: unknown }[] = [];
    const provider = new ReplicateProvider(
      "test-secret",
      async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input)
          .pathname;
        requests.push({
          path,
          method: init?.method ?? "GET",
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : null,
        });
        if (path.endsWith("/predictions"))
          return Response.json({
            id: "offline",
            status: "succeeded",
            version: "resolved",
            model: trial.model.model,
            output: ['{"action":"done","summary":"ok"}'],
            metrics: { input_token_count: 120, output_token_count: 8 },
            created_at: "2026-01-01",
          });
        return Response.json({
          is_official: true,
          latest_version: { id: "resolved", openapi_schema: schema },
        });
      },
    );
    const resolved = await provider.resolve(trial.model, 4096);
    const reply = await provider.predict(
      resolved,
      "prompt",
      suite.limits,
      evidence(),
      new AbortController().signal,
    );
    expect(parseAction(reply.text).action).toBe("done");
    expect(reply.usage).toEqual({
      inputTokens: 120,
      outputTokens: 8,
      estimated: false,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.path).toBe(
      `/v1/models/${trial.model.model}/predictions`,
    );
    expect(requests[1]?.body).toEqual({
      input: { prompt: "prompt", max_tokens: 4096, temperature: 0 },
    });
  });
  test("failed predictions preserve failure rather than parsing absent output", async () => {
    const provider = new ReplicateProvider("test-secret", async () =>
      Response.json({
        id: "failed-id",
        status: "failed",
        error: "provider failed",
        version: "v",
      }),
    );
    await expect(
      provider.predict(
        {
          model: trial.model,
          schemaVersion: "v",
          official: true,
          schema,
          parameters: {},
        },
        "p",
        suite.limits,
        evidence(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("ended failed");
  });
  test("SDK internal retries never resend an uncertain prediction request", async () => {
    let requests = 0;
    const provider = new ReplicateProvider("test-secret", async () => {
      requests += 1;
      throw new Error("connection lost after send");
    });
    await expect(
      provider.predict(
        {
          model: trial.model,
          schemaVersion: "v",
          official: true,
          schema,
          parameters: {},
        },
        "p",
        suite.limits,
        evidence(),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(PredictionUncertain);
    expect(requests).toBe(1);
  });
  test("aborted in-flight prediction is canceled once", async () => {
    const controller = new AbortController();
    const paths: string[] = [];
    const provider = new ReplicateProvider("test-secret", async (input) => {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      paths.push(path);
      if (path.endsWith("/cancel"))
        return Response.json({ id: "cancel-me", status: "canceled" });
      controller.abort(new Error("operator stopped"));
      return Response.json({
        id: "cancel-me",
        status: "processing",
        version: "v",
      });
    });
    await expect(
      provider.predict(
        {
          model: trial.model,
          schemaVersion: "v",
          official: true,
          schema,
          parameters: {},
        },
        "p",
        suite.limits,
        evidence(),
        controller.signal,
      ),
    ).rejects.toThrow("operator stopped");
    expect(paths.filter((path) => path.endsWith("/cancel"))).toHaveLength(1);
  });
});

describe("agent isolation and bounded recovery", () => {
  test("invalid JSON consumes a turn and recovers without running code", async () => {
    const agent = fakeAgent(["bad", '{"action":"done","summary":"recovered"}']);
    expect(await agent.stage("build")).toBe("recovered");
    expect(agent.protocolErrors).toBe(1);
    expect(agent.predictions).toBe(2);
  });
  test("budget exhaustion is not success", async () => {
    const agent = fakeAgent(["bad"], fakeMcp(), {
      limits: { ...suite.limits, turnsPerStage: 1 },
    });
    await expect(agent.stage("build")).rejects.toBeInstanceOf(BudgetFailure);
  });
  test("blocks shell-like tools and context path traversal", async () => {
    const mcp = fakeMcp();
    const agent = fakeAgent(
      [
        '{"action":"call_tool","name":"risky_eval","arguments":{"code":"bad"}}',
        '{"action":"read_context","path":"../../.env"}',
      ],
      mcp,
    );
    await agent.stage("build");
    expect(mcp.calls).toEqual([]);
  });
  test("project switching stops the agent before a mutation", async () => {
    const mcp = fakeMcp();
    mcp.call = async () => ({
      content: [
        {
          type: "resource_link",
          uri: "blockbench://project/other.bbmodel",
          name: "other",
        },
      ],
    });
    const agent = fakeAgent(
      ['{"action":"call_tool","name":"place_cube","arguments":{}}'],
      mcp,
    );
    await expect(agent.stage("build")).rejects.toThrow(
      "Active project changed",
    );
    expect(agent.toolCalls).toBe(0);
  });
  test("same-model reviewer shares prediction budget and cannot mutate", async () => {
    const mcp = fakeMcp();
    const agent = fakeAgent(
      [
        '{"action":"delegate","agent":"reviewer","task":"check"}',
        '{"action":"call_tool","name":"place_cube","arguments":{}}',
        '{"action":"done","summary":"review complete"}',
        '{"action":"done","summary":"primary complete"}',
      ],
      mcp,
    );
    expect(await agent.stage("build")).toBe("primary complete");
    expect(agent.predictions).toBe(4);
    expect(agent.delegations).toBe(1);
    expect(mcp.calls).toEqual([]);
  });
});

describe("trial lifecycle and evidence", () => {
  test("real Streamable HTTP sessions initialize separately and terminate", async () => {
    const sessions = new Map<
      string,
      WebStandardStreamableHTTPServerTransport
    >();
    const servers: McpServer[] = [];
    const initialized: string[] = [];
    const terminated: string[] = [];
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const session = request.headers.get("mcp-session-id");
        const existing = session ? sessions.get(session) : undefined;
        if (existing) return existing.handleRequest(request);
        if (session || request.method !== "POST")
          return new Response("Unknown session", { status: 404 });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            initialized.push(id);
            sessions.set(id, transport);
          },
          onsessionclosed: (id) => {
            terminated.push(id);
            sessions.delete(id);
          },
        });
        const server = new McpServer({
          name: "offline-benchmark-test",
          version: "1",
        });
        servers.push(server);
        server.registerTool(
          "get_project_info",
          { inputSchema: {} },
          async () => link,
        );
        await server.connect(transport as Transport);
        return transport.handleRequest(request);
      },
    });
    try {
      await sequential(["first", "second"], async (id) => {
        const client = await connect(`http://127.0.0.1:${http.port}/mcp`, id);
        try {
          expect((await client.tools()).map((item) => item.name)).toEqual([
            "get_project_info",
          ]);
          expect(projectUri(await client.call("get_project_info"))).toBe(uri);
        } finally {
          await client.close();
        }
      });
      expect(new Set(initialized).size).toBe(2);
      expect(terminated).toEqual(initialized);
    } finally {
      await sequential(servers, (server) => server.close());
      await http.stop(true);
    }
  });
  test("each trial connects independently, completes four stages and closes", async () => {
    const clients: ReturnType<typeof fakeMcp>[] = [];
    await sequential(
      [trial, { ...trial, id: `${trial.id}-repeat` }],
      async (cell) => {
        const output = evidence();
        const result = await runTrial(cell, {
          context,
          evidence: output,
          limits: suite.limits,
          signal: new AbortController().signal,
          connect: async () => {
            const client = fakeMcp();
            clients.push(client);
            return client;
          },
          predict: async () =>
            '{"action":"done","summary":"offline simulated completion"}',
        });
        expect(result.status).toBe("completed");
        expect(result.completedStages).toBe(4);
        expect(result.qualityScore).toBeNull();
        expect(
          await Bun.file(join(output.root, "final.bbmodel")).exists(),
        ).toBe(true);
        expect(
          await Bun.file(join(output.root, "views/perspective.json")).exists(),
        ).toBe(true);
      },
    );
    expect(clients).toHaveLength(2);
    expect(clients.every((client) => client.closed)).toBe(true);
  });
  test("project tools hidden until a project exists do not block setup or the agent", async () => {
    // Mirrors the plugin: project-dependent tools are unlisted until create_project runs.
    const hiddenWithoutProject = [
      "get_project_info",
      "set_camera_angle",
      "capture_screenshot",
      "place_cube",
    ];
    const client = fakeMcp();
    const call = client.call.bind(client);
    let projectOpen = false;
    client.tools = async () =>
      toolList.filter(
        (item) => projectOpen || !hiddenWithoutProject.includes(item.name),
      );
    client.call = async (name, args) => {
      if (name === "create_project") projectOpen = true;
      return call(name, args);
    };
    const replies = [
      '{"action":"call_tool","name":"place_cube","arguments":{}}',
    ];
    const result = await runTrial(
      { ...trial, condition: "scaffold" },
      {
        context,
        evidence: evidence(),
        limits: suite.limits,
        signal: new AbortController().signal,
        connect: async () => client,
        predict: async () =>
          replies.shift() ?? '{"action":"done","summary":"finished"}',
      },
    );
    expect(result.error).toBeNull();
    expect(result.status).toBe("completed");
    expect(result.toolCalls).toBe(1);
    expect(client.calls.filter((name) => name === "place_cube")).toHaveLength(
      2,
    );
  });
  test("prediction failure saves partial project and closes MCP", async () => {
    const client = fakeMcp();
    const output = evidence();
    const result = await runTrial(trial, {
      context,
      evidence: output,
      limits: suite.limits,
      signal: new AbortController().signal,
      connect: async () => client,
      predict: async () => {
        throw new Error("simulated provider failure");
      },
    });
    expect(result.status).toBe("failed");
    expect(result.completedStages).toBe(0);
    expect(client.closed).toBe(true);
    expect(await Bun.file(join(output.root, "final.bbmodel")).exists()).toBe(
      true,
    );
  });
  test("MCP timeout marks state uncertain and still closes client", async () => {
    const client = fakeMcp();
    client.call = async () => {
      throw new Error("request timed out");
    };
    const result = await runTrial(trial, {
      context,
      evidence: evidence(),
      limits: suite.limits,
      signal: new AbortController().signal,
      connect: async () => client,
      predict: async () => "never",
    });
    expect(result.status).toBe("infrastructure-error");
    expect(client.closed).toBe(true);
    expect(result.predictions).toBe(0);
  });
  test("no visual score is fabricated from geometry counts", () => {
    expect(
      measureModel({ elements: [], textures: [], animations: [] }).elements,
    ).toBe(0);
    expect(JSON.stringify(reviewTemplate(trial.asset))).toContain(
      '"score":null',
    );
    expect(projectUri(link)).toBe(uri);
    expect(reviewedScore(reviewTemplate(trial.asset), [], [])).toBeNull();
    expect(() =>
      reviewedScore({ status: "reviewed", reviewer: "" }, [], []),
    ).toThrow();
    const review = {
      status: "reviewed",
      reviewer: "human",
      reviewedAt: "2026-09-18T12:00:00Z",
      dimensions: {
        geometry: {
          score: 3,
          evidence: ["final.bbmodel"],
          notes: "minor issue",
        },
      },
      acceptance: [
        {
          criterion: "valid",
          met: true,
          evidence: ["final.bbmodel"],
          notes: "",
        },
      ],
    };
    expect(reviewedScore(review, ["geometry"], ["valid"])).toBe(3);
    expect(() =>
      reviewedScore(review, ["geometry", "texture"], ["valid"]),
    ).toThrow();
  });
  test("redacts credentials and preserves extracted binary artifacts", async () => {
    expect(redact("test-secret Bearer abc123", ["test-secret"])).toBe(
      "[REDACTED] Bearer [REDACTED]",
    );
    const output = evidence();
    await output.json("test.json", { echoed: "test-secret" });
    expect(await Bun.file(join(output.root, "test.json")).text()).not.toContain(
      "test-secret",
    );
    const image = { type: "image", mimeType: "image/png", data: "dGVzdA==" };
    expect(await output.materialize(image)).toEqual(
      await output.materialize(image),
    );
    expect(
      await Bun.file(join(output.root, "artifacts/00001.png")).text(),
    ).toBe("test");
  });
});

describe("cost projection and cap", () => {
  const priced: Model = {
    ...trial.model,
    pricing: {
      inputPerMillionUsd: 3,
      outputPerMillionUsd: 15,
      source: "https://replicate.com/example/model",
      checkedAt: "2026-09-18",
    },
  };
  const unpriced: Model = {
    ...trial.model,
    id: "unpriced",
    pricing: undefined,
  };
  const limits = { ...suite.limits, outputTokens: 1000 };
  const reply = (inputTokens: number, outputTokens: number) => async () => ({
    text: "ok",
    usage: { inputTokens, outputTokens, estimated: false },
  });

  test("prices tokens per million and leaves unpriced models null", () => {
    expect(
      tokenCost(priced, { inputTokens: 1_000_000, outputTokens: 100_000 }),
    ).toBeCloseTo(4.5);
    expect(tokenCost(unpriced, { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(estimateTokens(300)).toBe(100);
  });
  test("ceiling assumes every prediction at the context and output caps", () => {
    const small = {
      ...suite,
      models: [priced, unpriced],
      limits: { ...limits, predictionsPerTrial: 10, contextCharacters: 3000 },
    };
    const [pricedCeiling, unpricedCeiling] = projectCeilings(
      small,
      matrix(small),
    );
    const trials = small.cases.length * small.conditions.length;
    // 10 predictions x (1000 input tokens x $3/M + 1000 output tokens x $15/M) per trial.
    expect(pricedCeiling?.ceilingUsd).toBeCloseTo(trials * 10 * 0.018);
    expect(pricedCeiling?.maxPredictions).toBe(trials * 10);
    expect(unpricedCeiling?.ceilingUsd).toBeNull();
  });
  test("reads reported tokens and falls back to conservative estimates", () => {
    expect(
      tokenUsage({ input_token_count: 5, output_token_count: 6 }, "abc", 900),
    ).toEqual({ inputTokens: 5, outputTokens: 6, estimated: false });
    expect(tokenUsage(undefined, "x".repeat(30), 900)).toEqual({
      inputTokens: 10,
      outputTokens: 900,
      estimated: true,
    });
  });
  test("refuses a prediction whose worst case would pass the cap", async () => {
    // Worst case per 3000-char prompt: 1000 x $3/M + 1000 x $15/M = $0.018.
    const ledger = new CostLedger([priced], limits, 0.03);
    const prompt = "x".repeat(3000);
    let calls = 0;
    const counted = async () => {
      calls += 1;
      return reply(1000, 1000)();
    };
    expect(await ledger.charge(priced, prompt, counted)).toBe("ok");
    await expect(ledger.charge(priced, prompt, counted)).rejects.toBeInstanceOf(
      CostCapReached,
    );
    expect(calls).toBe(1);
    expect(ledger.spentUsd).toBeCloseTo(0.018);
  });
  test("charges a failed prediction its worst case", async () => {
    const ledger = new CostLedger([priced], limits, undefined);
    await expect(
      ledger.charge(priced, "x".repeat(3000), async () => {
        throw new Error("provider failed");
      }),
    ).rejects.toThrow("provider failed");
    expect(ledger.spendFor(priced)).toMatchObject({
      predictions: 1,
      estimatedPredictions: 1,
      costUsd: 0.018,
    });
  });
  test("a cap requires pricing for every model", () => {
    expect(() => new CostLedger([priced, unpriced], limits, 10)).toThrow(
      "unpriced",
    );
    expect(() => new CostLedger([unpriced], limits, undefined)).not.toThrow();
  });
  test("reaching the cap mid-trial is recorded as cost-capped and closes MCP", async () => {
    const client = fakeMcp();
    const result = await runTrial(trial, {
      context,
      evidence: evidence(),
      limits: suite.limits,
      signal: new AbortController().signal,
      connect: async () => client,
      predict: async () => {
        throw new CostCapReached("cap");
      },
    });
    expect(result.status).toBe("cost-capped");
    expect(client.closed).toBe(true);
  });
});

describe("budget suite", () => {
  test("covers every provider, prices every model, and any one trial fits under the cap", async () => {
    const budget = suiteSchema.parse(
      await Bun.file(new URL("suite.budget.json", import.meta.url)).json(),
    );
    const trials = matrix(budget);
    // The whole matrix may exceed the cap; the ledger stops the run there. But a
    // single trial's worst case must fit, or the cap could block even one trial.
    const worstTrial = Math.max(
      ...projectCeilings(budget, trials).map(
        (row) => (row.ceilingUsd ?? Number.POSITIVE_INFINITY) / row.trials,
      ),
    );
    expect(new Set(budget.models.map((model) => model.provider)).size).toBe(7);
    expect(trials).toHaveLength(14);
    expect(budget.maxCostUsd).toBe(20);
    expect(
      () => new CostLedger(budget.models, budget.limits, budget.maxCostUsd),
    ).not.toThrow();
    expect(worstTrial).toBeLessThan(budget.maxCostUsd ?? 0);
  });
});

describe("Replicate rate limits", () => {
  const schema = {
    components: {
      schemas: {
        Input: {
          properties: {
            prompt: { type: "string" },
            max_tokens: { type: "integer" },
          },
          required: ["prompt"],
        },
      },
    },
  };
  const resolved = {
    model: trial.model,
    schemaVersion: "v",
    official: true,
    schema,
    parameters: {},
  };
  const throttled = (): Response =>
    Response.json(
      { detail: "Request was throttled. Your rate limit resets in ~0s." },
      { status: 429 },
    );
  const succeeded = (): Response =>
    Response.json({
      id: "ok",
      status: "succeeded",
      version: "v",
      output: ['{"action":"done","summary":"ok"}'],
    });
  const apiError = (response: Response, message = ""): Error =>
    Object.assign(new Error(message), { response });

  test("reads the reset hint, a Retry-After header, or backs off", () => {
    expect(
      throttleDelayMs(
        apiError(new Response(null, { status: 429 }), "resets in ~30s."),
        0,
      ),
    ).toBe(30_000);
    expect(
      throttleDelayMs(
        apiError(
          new Response(null, { status: 429, headers: { "Retry-After": "7" } }),
        ),
        0,
      ),
    ).toBe(7000);
    expect(
      throttleDelayMs(apiError(new Response(null, { status: 429 })), 2),
    ).toBe(8000);
    expect(
      throttleDelayMs(apiError(new Response(null, { status: 500 })), 0),
    ).toBeUndefined();
    expect(throttleDelayMs(new Error("offline"), 0)).toBeUndefined();
  });
  test("a throttled create is waited out and sent again exactly once more", async () => {
    const creates: (string | null)[] = [];
    const provider = new ReplicateProvider(
      "test-secret",
      async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input)
          .pathname;
        if (!path.endsWith("/predictions")) return succeeded();
        creates.push(new Headers(init?.headers).get("Prefer"));
        return creates.length === 1 ? throttled() : succeeded();
      },
    );
    const reply = await provider.predict(
      resolved,
      "p",
      suite.limits,
      evidence(),
      new AbortController().signal,
    );
    expect(parseAction(reply.text).action).toBe("done");
    // The SDK's instant internal retries reuse the cached 429 instead of re-sending.
    expect(creates).toEqual(["wait=30", "wait=30"]);
  });
  test("persistent throttling stops as rate-limited, never as an uncertain prediction", async () => {
    let creates = 0;
    const provider = new ReplicateProvider("test-secret", async () => {
      creates += 1;
      return throttled();
    });
    await expect(
      provider.predict(
        resolved,
        "p",
        suite.limits,
        evidence(),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RateLimited);
    expect(creates).toBe(maxThrottleAttempts);
  });
  test("a throttled status poll is retried", async () => {
    const paths: string[] = [];
    const provider = new ReplicateProvider("test-secret", async (input) => {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      paths.push(path);
      if (path.endsWith("/predictions")) {
        return Response.json({
          id: "slow",
          status: "processing",
          version: "v",
        });
      }
      return paths.length === 2 ? throttled() : succeeded();
    });
    const reply = await provider.predict(
      resolved,
      "p",
      suite.limits,
      evidence(),
      new AbortController().signal,
    );
    expect(reply.text).toContain("done");
    expect(
      paths.filter((path) => path.endsWith("/predictions/slow")),
    ).toHaveLength(2);
  });
  test("the spacer holds requests to the minimum interval", async () => {
    const spacer = new RequestSpacer(40);
    const start = performance.now();
    await spacer.reserve(undefined);
    await spacer.reserve(undefined);
    await spacer.reserve(undefined);
    expect(performance.now() - start).toBeGreaterThanOrEqual(75);
  });
  test("a rate-limited trial is recorded as such and closes MCP", async () => {
    const client = fakeMcp();
    const result = await runTrial(trial, {
      context,
      evidence: evidence(),
      limits: suite.limits,
      signal: new AbortController().signal,
      connect: async () => client,
      predict: async () => {
        throw new RateLimited("throttled");
      },
    });
    expect(result.status).toBe("rate-limited");
    expect(client.closed).toBe(true);
  });
});
