import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { BudgetFailure, McpFailure } from "./agent";
import { CliAgent } from "./cli-agent";
import { modelSchema, suiteSchema } from "./config";
import type { IContext } from "./context";
import { Evidence } from "./evidence";
import { connect, type IMcp } from "./mcp";
import { guidanceTool, PolicyProxy } from "./proxy";
import {
  claudeRunner,
  codexRunner,
  geminiRunner,
  type ICliRunner,
  type ICliStage,
} from "./runners";

const root = join(tmpdir(), `blockbench-cli-track-${Bun.randomUUIDv7()}`);
let count = 0;
afterAll(async () => {
  if (!resolve(root).startsWith(resolve(tmpdir()))) {
    throw new Error("Unsafe test cleanup path.");
  }
  await rm(root, { recursive: true, force: true });
});
const evidence = (): Evidence => new Evidence(join(root, String(++count)));

const project = "blockbench://project/cli.bbmodel";
const view = "benchmark_evidence";
const context: IContext = {
  files: {
    "AGENTS.md": "Use MCP.",
    "skills/blockbench-use/SKILL.md": "Inspect first.",
  },
  hashes: {},
  agents: {},
};
const suite = suiteSchema.parse(
  await Bun.file(new URL("suite.cli.json", import.meta.url)).json(),
);
const tool = (name: string): Tool => ({
  name,
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
});

/** Fake Blockbench: an outline tool, a screenshot tool, and one banned tool. */
function upstream(): IMcp & { calls: string[]; project: string } {
  return {
    calls: [],
    project,
    tools: async () =>
      [
        "get_project_info",
        "list_outline",
        "capture_screenshot",
        "risky_eval",
      ].map(tool),
    async call(name) {
      this.calls.push(name);
      if (name === "get_project_info") {
        return {
          content: [{ type: "resource_link", name: "p", uri: this.project }],
        };
      }
      if (name === "capture_screenshot") {
        return {
          content: [{ type: "image", mimeType: "image/png", data: "dGVzdA==" }],
        };
      }
      return { content: [{ type: "text", text: "outline: 1 cube" }] };
    },
    read: async () => ({ contents: [{ uri: project, text: "{}" }] }),
    close: async () => {},
  };
}

async function withProxy<T>(
  work: (
    proxy: PolicyProxy,
    client: IMcp,
    fake: ReturnType<typeof upstream>,
  ) => Promise<T>,
): Promise<T> {
  const fake = upstream();
  const proxy = await PolicyProxy.start({
    upstream: fake,
    evidence: evidence(),
    context,
    project,
    view,
    observationCharacters: 8000,
  });
  const client = await connect(proxy.url, "test");
  try {
    return await work(proxy, client, fake);
  } finally {
    await client.close();
    await proxy.close();
  }
}

const text = (result: CallToolResult): string =>
  result.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join(" ");

describe("policy proxy", () => {
  test("lists allowed tools plus the guidance reader, never banned tools", async () => {
    await withProxy(async (_proxy, client) => {
      const names = (await client.tools()).map((item) => item.name);
      expect(names).toContain("list_outline");
      expect(names).toContain(guidanceTool);
      expect(names).not.toContain("risky_eval");
    });
  });
  test("forwards allowed calls and blocks banned tools, wrong views and paths", async () => {
    await withProxy(async (proxy, client, fake) => {
      expect(text(await client.call("list_outline"))).toBe("outline: 1 cube");
      const banned = await client.call("risky_eval", { code: "1" });
      expect(banned.isError).toBe(true);
      const wrongView = await client.call("capture_screenshot", {
        view: "other",
      });
      expect(text(wrongView)).toContain("assigned offscreen view");
      const path = await client.call("list_outline", { path: "C:/secret" });
      expect(text(path)).toContain("Filesystem paths");
      expect(fake.calls.filter((name) => name !== "get_project_info")).toEqual([
        "list_outline",
      ]);
      expect(proxy.toolCalls).toBe(1);
    });
  });
  test("returns text in place of images and serves guidance files", async () => {
    await withProxy(async (_proxy, client) => {
      const shot = await client.call("capture_screenshot", { view });
      expect(text(shot)).toContain("archived as artifacts/00001.png");
      const guide = await client.call(guidanceTool, { path: "AGENTS.md" });
      expect(text(guide)).toBe("Use MCP.");
      const missing = await client.call(guidanceTool, { path: "../.env" });
      expect(missing.isError).toBe(true);
    });
  });
  test("enforces the per-stage tool budget", async () => {
    await withProxy(async (proxy, client) => {
      proxy.beginStage(1);
      expect((await client.call("list_outline")).isError).toBeFalsy();
      const over = await client.call("list_outline");
      expect(text(over)).toContain("budget for this stage is used up");
      expect(proxy.stageExhausted).toBe(true);
      proxy.beginStage(1);
      expect((await client.call("list_outline")).isError).toBeFalsy();
    });
  });
  test("a project switch is fatal and aborts the fatal signal", async () => {
    await withProxy(async (proxy, client, fake) => {
      fake.project = "blockbench://project/other.bbmodel";
      const result = await client.call("list_outline");
      expect(text(result)).toContain("Active project changed");
      expect(proxy.fatal).toBeInstanceOf(McpFailure);
      expect(proxy.fatalSignal.aborted).toBe(true);
    });
  });
});

describe("CLI runners", () => {
  const stage = (overrides: Partial<ICliStage> = {}): ICliStage => ({
    model: modelSchema.parse({
      id: "m",
      provider: "Anthropic",
      model: "sonnet",
      runner: "claude",
      source: "https://example.com",
    }),
    proxyUrl: "http://127.0.0.1:1234/mcp",
    workdir: "C:/work",
    session: undefined,
    newSession: "11111111-1111-1111-1111-111111111111",
    codexServers: ["blockbench", "node_repl"],
    ...overrides,
  });

  test("claude runs with no built-in tools, only the proxy, and no personal settings", () => {
    const first = claudeRunner.command(stage());
    expect(first.cmd).toEqual(
      expect.arrayContaining([
        "--strict-mcp-config",
        "--tools",
        "",
        "--setting-sources",
      ]),
    );
    expect(first.cmd).toContain("--session-id");
    expect(JSON.parse(first.files["mcp.json"] ?? "{}")).toEqual({
      mcpServers: { bench: { type: "http", url: "http://127.0.0.1:1234/mcp" } },
    });
    expect(claudeRunner.command(stage({ session: "abc" })).cmd).toEqual(
      expect.arrayContaining(["--resume", "abc"]),
    );
    const parsed = claudeRunner.parse(
      JSON.stringify({
        result: "done",
        session_id: "s1",
        is_error: false,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 5,
          output_tokens: 3,
        },
        modelUsage: { "claude-sonnet": {} },
      }),
      stage(),
    );
    expect(parsed).toEqual({
      summary: "done",
      session: "s1",
      usage: { inputTokens: 15, outputTokens: 3 },
      reportedModel: "claude-sonnet",
    });
    expect(() =>
      claudeRunner.parse(
        JSON.stringify({ is_error: true, result: "boom" }),
        stage(),
      ),
    ).toThrow("boom");
  });
  test("claude on an Ollama backend uses bare mode against the local API", () => {
    const local = stage({
      model: modelSchema.parse({
        id: "q",
        provider: "Qwen",
        model: "qwen3",
        runner: "claude",
        backend: "ollama",
        source: "https://example.com",
      }),
    });
    const command = claudeRunner.command(local);
    expect(command.cmd).toContain("--bare");
    expect(command.env.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
    expect(command.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("qwen3");
  });
  test("codex switches off personal MCP servers and shell features", () => {
    const model = modelSchema.parse({
      id: "c",
      provider: "OpenAI",
      model: "default",
      runner: "codex",
      source: "https://example.com",
    });
    const command = codexRunner.command(stage({ model }));
    expect(command.cmd).toEqual(
      expect.arrayContaining([
        "mcp_servers.blockbench.enabled=false",
        "mcp_servers.node_repl.enabled=false",
        "shell_tool",
        "read-only",
      ]),
    );
    expect(command.cmd).not.toContain("-m");
    expect(
      codexRunner.command(stage({ model, session: "t1" })).cmd.slice(0, 3),
    ).toEqual(["codex", "exec", "resume"]);
    const events = [
      { type: "thread.started", thread_id: "t1" },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "first" },
      },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "final" },
      },
      { type: "turn.completed", usage: { input_tokens: 7, output_tokens: 2 } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    expect(codexRunner.parse(events, stage({ model }))).toEqual({
      summary: "final",
      session: "t1",
      usage: { inputTokens: 7, outputTokens: 2 },
      reportedModel: undefined,
    });
    expect(() =>
      codexRunner.parse(
        JSON.stringify({ type: "turn.failed", error: { message: "no" } }),
        stage({ model }),
      ),
    ).toThrow("Codex reported");
  });
  test("gemini gets its own system settings file and only the proxy server", () => {
    const model = modelSchema.parse({
      id: "g",
      provider: "Google",
      model: "default",
      runner: "gemini",
      source: "https://example.com",
    });
    const command = geminiRunner.command(stage({ model }));
    expect(command.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(
      "C:/work/gemini-settings.json",
    );
    expect(command.cmd).toEqual(
      expect.arrayContaining([
        "--allowed-mcp-server-names",
        "bench",
        "--approval-mode",
        "yolo",
      ]),
    );
    const settings = JSON.parse(command.files["gemini-settings.json"] ?? "{}");
    expect(settings.mcpServers.bench.httpUrl).toBe("http://127.0.0.1:1234/mcp");
    expect(settings.security).toBeUndefined();
    const parsed = geminiRunner.parse(
      `YOLO mode is enabled.\n${JSON.stringify({ session_id: "g1", response: "ok", stats: { models: { "gemini-pro": { tokens: { prompt: 9, candidates: 4, thoughts: 1 } } } } })}`,
      stage({ model }),
    );
    expect(parsed).toEqual({
      summary: "ok",
      session: "g1",
      usage: { inputTokens: 9, outputTokens: 5 },
      reportedModel: "gemini-pro",
    });
    expect(() =>
      geminiRunner.parse(
        JSON.stringify({ error: { message: "Please set an Auth method" } }),
        stage({ model }),
      ),
    ).toThrow("Auth method");
  });
});

describe("CLI agent", () => {
  /** Runner that starts the fake CLI with Bun, passing the proxy URL and session. */
  const fakeRunner: ICliRunner = {
    command: (stage) => ({
      cmd: [
        "bun",
        resolve(import.meta.dir, "fixtures/fake-cli.ts"),
        stage.proxyUrl,
        stage.session ?? stage.newSession,
      ],
      env: {},
      files: {},
    }),
    parse: (stdout, stage) => {
      const result = JSON.parse(stdout) as { result: string; session: string };
      return {
        summary: result.result,
        session: result.session ?? stage.session,
        usage: { inputTokens: 1, outputTokens: 1 },
        reportedModel: undefined,
      };
    },
  };
  const model = modelSchema.parse({
    id: "fake",
    provider: "Anthropic",
    model: "default",
    runner: "claude",
    source: "https://example.com",
  });

  async function agentWith(limits: Partial<typeof suite.limits> = {}) {
    const fake = upstream();
    const output = evidence();
    const proxy = await PolicyProxy.start({
      upstream: fake,
      evidence: output,
      context,
      project,
      view,
      observationCharacters: 8000,
    });
    const workdir = join(output.root, "work");
    await Bun.write(join(workdir, ".keep"), "");
    const agent = new CliAgent({
      runner: fakeRunner,
      model,
      proxy,
      evidence: output,
      context,
      limits: { ...suite.limits, ...limits },
      signal: new AbortController().signal,
      project,
      view,
      workdir,
      codexServers: [],
    });
    return { agent, proxy, fake, output };
  }

  test("runs stages through the proxy and keeps one session", async () => {
    const { agent, proxy } = await agentWith();
    try {
      expect(await agent.stage("Build.\nCALL list_outline")).toBe(
        "outline: 1 cube",
      );
      expect(await agent.stage("Texture.\nCALL list_outline")).toBe(
        "outline: 1 cube",
      );
      expect(agent.predictions).toBe(2);
      expect(agent.toolCalls).toBe(2);
      expect(agent.usage).toEqual({ inputTokens: 2, outputTokens: 2 });
    } finally {
      await agent.close();
    }
    expect(proxy.toolCalls).toBe(2);
  });
  test("running out of the stage tool budget is not completion", async () => {
    const { agent } = await agentWith({ toolCallsPerStage: 2 });
    try {
      await expect(
        agent.stage("Build.\nCALL list_outline 3"),
      ).rejects.toBeInstanceOf(BudgetFailure);
    } finally {
      await agent.close();
    }
  });
  test("a stage past its time limit is killed and reported as a budget failure", async () => {
    const { agent } = await agentWith({ stageTimeoutMs: 1500 });
    const started = performance.now();
    try {
      await expect(agent.stage("Build.\nSLEEP 20000")).rejects.toThrow(
        "time limit",
      );
    } finally {
      await agent.close();
    }
    expect(performance.now() - started).toBeLessThan(10_000);
  });
  test("a project switch during a stage stops it as an infrastructure failure", async () => {
    const { agent, fake } = await agentWith();
    fake.project = "blockbench://project/other.bbmodel";
    try {
      await expect(
        agent.stage("Build.\nCALL list_outline"),
      ).rejects.toBeInstanceOf(McpFailure);
    } finally {
      await agent.close();
    }
  });
});

describe("CLI suite", () => {
  test("every model is a local CLI and the ceiling needs no Replicate token", () => {
    expect(suite.models.every((item) => item.runner !== "replicate")).toBe(
      true,
    );
    expect(
      suite.models
        .filter((item) => item.backend === "ollama")
        .map((item) => item.model),
    ).toEqual(["gpt-oss", "kimi-k2.6:cloud"]);
  });
});
