import type { Model } from "./config";

/**
 * Command builders and output parsers for the agent CLIs. Every runner connects the
 * CLI to the benchmark's policy proxy as its only MCP server (named `bench`), turns
 * off built-in shell, file, web and plugin tools, and ignores the operator's personal
 * configuration, so the CLI can only act through the proxy. Prompts go through stdin:
 * the npm shims for codex and gemini are `.cmd` files, and cmd.exe would mangle
 * newlines and quotes in arguments.
 */

/** MCP server name the CLIs see; Claude exposes its tools as `mcp__bench__*`. */
export const proxyServerName = "bench";

/** Where Ollama serves its Anthropic-compatible API for Claude Code. */
const ollamaBaseUrl = "http://localhost:11434";

/** Codex features that would give the agent tools outside the proxy. */
const codexDisabledFeatures = [
  "shell_tool",
  "unified_exec",
  "apps",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "image_generation",
  "multi_agent",
  "plugins",
  "remote_plugin",
  "hooks",
  "skill_search",
  "tool_suggest",
  "view_image",
] as const;

/** What a runner needs to build one stage's command. */
export interface ICliStage {
  model: Model;
  proxyUrl: string;
  /** Empty per-trial scratch folder used as the CLI's working directory. */
  workdir: string;
  /** Session to continue; undefined for the first stage. */
  session: string | undefined;
  /** Session ID to create on the first stage, for CLIs that accept one. */
  newSession: string;
  /** MCP server names from the operator's Codex config, which are switched off. */
  codexServers: readonly string[];
}

/** A command to spawn, extra environment, and files to write into the workdir first. */
export interface ICliCommand {
  cmd: string[];
  env: Record<string, string>;
  files: Record<string, string>;
}

/** Tokens the CLI reported for one stage; missing counts stay undefined. */
export interface ICliUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

/** The agent's final message for a stage, and what is needed to continue its session. */
export interface ICliOutcome {
  summary: string;
  session: string | undefined;
  usage: ICliUsage;
  /** Model name the CLI reported using, when it says. */
  reportedModel: string | undefined;
}

/** Builds commands for one CLI and reads its output. */
export interface ICliRunner {
  command(stage: ICliStage): ICliCommand;
  /** Throws with the CLI's own error message when the run failed. */
  parse(stdout: string, stage: ICliStage): ICliOutcome;
}

/** Arguments that pick a model, or none to use the CLI's default. */
function modelArgs(flag: string, model: Model): string[] {
  return model.model === "default" ? [] : [flag, model.model];
}

/** Parses the last JSON object in output that may start with log lines. */
function lastJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const start = [0, ...[...trimmed.matchAll(/\n\{/g)].map((m) => m.index + 1)]
    .toReversed()
    .find((index) => {
      try {
        JSON.parse(trimmed.slice(index));
        return true;
      } catch {
        return false;
      }
    });
  if (start === undefined) {
    throw new Error(`CLI output was not JSON: ${trimmed.slice(0, 300)}`);
  }
  const parsed: unknown = JSON.parse(trimmed.slice(start));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CLI output was not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** Reads a number from a record, or undefined. */
function numberAt(record: unknown, key: string): number | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

/** Adds counts, keeping undefined only when every part is missing. */
function sum(...values: (number | undefined)[]): number | undefined {
  const present = values.filter((value) => value !== undefined);
  return present.length
    ? present.reduce((total, value) => total + value, 0)
    : undefined;
}

/**
 * Claude Code in print mode. `--tools ""` removes every built-in tool,
 * `--strict-mcp-config` loads only the proxy, and `--setting-sources ""` skips the
 * operator's settings, hooks, plugins and CLAUDE.md. With an Ollama backend it
 * runs `--bare` against Ollama's Anthropic-compatible API instead of an account.
 */
export const claudeRunner: ICliRunner = {
  command(stage) {
    const ollama = stage.model.backend === "ollama";
    const mcp = {
      mcpServers: { [proxyServerName]: { type: "http", url: stage.proxyUrl } },
    };
    const env: Record<string, string> = ollama
      ? {
          ANTHROPIC_BASE_URL: ollamaBaseUrl,
          ANTHROPIC_API_KEY: "ollama",
          ANTHROPIC_AUTH_TOKEN: "ollama",
          ANTHROPIC_DEFAULT_OPUS_MODEL: stage.model.model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: stage.model.model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: stage.model.model,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        }
      : {};
    return {
      cmd: [
        "claude",
        "-p",
        "--output-format",
        "json",
        "--mcp-config",
        `${stage.workdir}/mcp.json`,
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--tools",
        "",
        "--allowedTools",
        `mcp__${proxyServerName}`,
        ...(ollama ? ["--bare"] : []),
        ...modelArgs("--model", stage.model),
        ...(stage.session
          ? ["--resume", stage.session]
          : ["--session-id", stage.newSession]),
      ],
      env,
      files: { "mcp.json": JSON.stringify(mcp) },
    };
  },
  parse(stdout, stage) {
    const result = lastJsonObject(stdout);
    const text = typeof result.result === "string" ? result.result : "";
    if (result.is_error === true) {
      throw new Error(
        `Claude reported an error: ${text || String(result.subtype)}`,
      );
    }
    const usage = result.usage;
    const models = result.modelUsage;
    return {
      summary: text,
      session:
        typeof result.session_id === "string"
          ? result.session_id
          : (stage.session ?? stage.newSession),
      usage: {
        inputTokens: sum(
          numberAt(usage, "input_tokens"),
          numberAt(usage, "cache_creation_input_tokens"),
          numberAt(usage, "cache_read_input_tokens"),
        ),
        outputTokens: numberAt(usage, "output_tokens"),
      },
      reportedModel:
        typeof models === "object" && models !== null
          ? Object.keys(models).join(",")
          : undefined,
    };
  },
};

/**
 * Codex in `exec` mode with JSONL events. Built-in shell, apps, browser and plugin
 * features are disabled, the operator's own MCP servers are switched off, and the
 * read-only sandbox in an empty folder is a backstop.
 */
export const codexRunner: ICliRunner = {
  command(stage) {
    const flags = [
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      // Values that are not valid TOML are read as plain strings, so no quoting is needed.
      "-c",
      `mcp_servers.${proxyServerName}.url=${stage.proxyUrl}`,
      "-c",
      "web_search=disabled",
      ...stage.codexServers
        .filter((name) => name !== proxyServerName)
        .flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
      ...codexDisabledFeatures.flatMap((feature) => ["--disable", feature]),
      ...modelArgs("-m", stage.model),
    ];
    return {
      cmd: stage.session
        ? ["codex", "exec", "resume", ...flags, stage.session, "-"]
        : ["codex", "exec", "-C", stage.workdir, ...flags, "-"],
      env: {},
      files: {},
    };
  },
  parse(stdout, stage) {
    const events = stdout
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .flatMap((line): Record<string, unknown>[] => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    const failure = events.find(
      (event) => event.type === "turn.failed" || event.type === "error",
    );
    if (failure) {
      throw new Error(
        `Codex reported an error: ${JSON.stringify(failure).slice(0, 500)}`,
      );
    }
    const thread = events.find((event) => event.type === "thread.started");
    const messages = events.flatMap((event) => {
      const item = event.item as Record<string, unknown> | undefined;
      return event.type === "item.completed" &&
        item?.type === "agent_message" &&
        typeof item.text === "string"
        ? [item.text]
        : [];
    });
    const turns = events
      .filter((event) => event.type === "turn.completed")
      .map((event) => event.usage);
    return {
      summary: messages.at(-1) ?? "",
      session:
        typeof thread?.thread_id === "string"
          ? thread.thread_id
          : stage.session,
      usage: {
        inputTokens: sum(
          ...turns.map((usage) => numberAt(usage, "input_tokens")),
        ),
        outputTokens: sum(
          ...turns.map((usage) => numberAt(usage, "output_tokens")),
        ),
      },
      reportedModel: undefined,
    };
  },
};

/**
 * Gemini CLI in headless JSON mode. A system settings file (which overrides user
 * and project settings) points it at the proxy, allows no built-in tools, skips
 * GEMINI.md memory. It leaves `security` alone so the operator's sign-in still applies.
 * `--allowed-mcp-server-names`
 * keeps any MCP servers from the operator's settings or extensions out.
 */
export const geminiRunner: ICliRunner = {
  command(stage) {
    const settings = {
      mcpServers: {
        [proxyServerName]: { httpUrl: stage.proxyUrl, trust: true },
      },
      tools: { core: ["__benchmark_no_builtin_tools__"] },
      context: { fileName: ["__benchmark_no_memory__.md"] },
    };
    return {
      cmd: [
        "gemini",
        "-o",
        "json",
        "--approval-mode",
        "yolo",
        "--allowed-mcp-server-names",
        proxyServerName,
        ...modelArgs("-m", stage.model),
        ...(stage.session ? ["--resume", "latest"] : []),
        // Appended to the stdin prompt; a plain word survives cmd.exe unchanged.
        "-p",
        "Begin.",
      ],
      env: {
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: `${stage.workdir}/gemini-settings.json`,
      },
      files: { "gemini-settings.json": JSON.stringify(settings) },
    };
  },
  parse(stdout) {
    const result = lastJsonObject(stdout);
    if (result.error) {
      throw new Error(
        `Gemini reported an error: ${JSON.stringify(result.error).slice(0, 500)}`,
      );
    }
    const stats = result.stats as Record<string, unknown> | undefined;
    const models = Object.entries(
      (stats?.models as Record<string, unknown> | undefined) ?? {},
    );
    const tokens = models.map(
      ([, value]) => (value as Record<string, unknown> | undefined)?.tokens,
    );
    return {
      summary: typeof result.response === "string" ? result.response : "",
      // Each trial has its own working folder, so "latest" resumes this trial's session.
      session:
        typeof result.session_id === "string" ? result.session_id : "latest",
      usage: {
        inputTokens: sum(
          ...tokens.map((t) => numberAt(t, "prompt") ?? numberAt(t, "input")),
        ),
        outputTokens: sum(
          ...tokens.map((t) =>
            sum(numberAt(t, "candidates"), numberAt(t, "thoughts")),
          ),
        ),
      },
      reportedModel: models.map(([name]) => name).join(",") || undefined,
    };
  },
};

/** Runner for each CLI a suite can name. */
export const runners: Readonly<
  Record<"claude" | "codex" | "gemini", ICliRunner>
> = {
  claude: claudeRunner,
  codex: codexRunner,
  gemini: geminiRunner,
};
