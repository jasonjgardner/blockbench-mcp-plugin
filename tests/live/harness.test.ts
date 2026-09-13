import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { desktopSuites, repositoryRoot } from "@/build/release-evidence";
import {
  DEFAULT_ENDPOINT, ENDPOINT_ENV_VAR, LiveSession, MAX_EXPORT_CONTENT_LENGTH, resolveEndpoint, runThenClose, suiteArtifactPath, suiteResultPath,
} from "./harness";

const originalEndpoint = Bun.env[ENDPOINT_ENV_VAR];

afterEach(() => {
  delete Bun.env[ENDPOINT_ENV_VAR];
  if (originalEndpoint !== undefined) Bun.env[ENDPOINT_ENV_VAR] = originalEndpoint;
});

/** A session whose checks can be exercised without connecting to Blockbench. */
function offlineSession(): LiveSession {
  return new LiveSession(new Client({ name: "harness-test", version: "0.0.0" }), new URL(DEFAULT_ENDPOINT));
}

describe("endpoint resolution", () => {
  test("defaults to the plugin's shared port and path", () => {
    delete Bun.env[ENDPOINT_ENV_VAR];
    expect(DEFAULT_ENDPOINT).toBe("http://localhost:3000/bb-mcp");
    expect(resolveEndpoint(undefined).href).toBe("http://localhost:3000/bb-mcp");
  });

  test("prefers an explicit argument over the environment override", () => {
    Bun.env[ENDPOINT_ENV_VAR] = "http://localhost:3100/env";
    expect(resolveEndpoint(undefined).href).toBe("http://localhost:3100/env");
    expect(resolveEndpoint("http://127.0.0.1:4000/cli").href).toBe("http://127.0.0.1:4000/cli");
  });

  test("keeps exports large enough for inline project JSON", () => {
    expect(MAX_EXPORT_CONTENT_LENGTH).toBe(1_000_000);
  });
});

describe("suite paths", () => {
  test("result paths come from the release evidence table", () => {
    desktopSuites.forEach(suite => expect(suiteResultPath(suite.name)).toBe(join(repositoryRoot, suite.result)));
  });

  test("artifact paths live beside each suite's result file", () => {
    expect(suiteArtifactPath("identity", "front.png")).toBe(join(repositoryRoot, "artifacts", "mcp-identity", "front.png"));
    expect(suiteArtifactPath("actions")).toBe(join(repositoryRoot, "artifacts", "action-wrappers"));
    expect(suiteArtifactPath("pbr", "fixtures", "color.png")).toBe(join(repositoryRoot, "artifacts", "pbr", "fixtures", "color.png"));
  });
});

describe("check recording", () => {
  test("check records every passing label in order and throws the label on failure", () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const session: LiveSession = offlineSession();
    session.check(true, "first");
    session.check(1, "first");
    expect(() => session.check(0, "failing label")).toThrow("failing label");
    expect(session.checks).toEqual(["first", "first"]);
    expect(log).toHaveBeenCalledWith("PASS first");
    log.mockRestore();
  });

  test("checkOnce records a repeated invariant once but still fails later violations", () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const session: LiveSession = offlineSession();
    session.checkOnce(true, "tool structured and text content agree");
    session.check(true, "other");
    session.checkOnce(true, "tool structured and text content agree");
    expect(() => session.checkOnce(false, "tool structured and text content agree")).toThrow("agree");
    expect(session.checks).toEqual(["tool structured and text content agree", "other"]);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});

describe("safe client close", () => {
  test("returns the work result after a successful close", async () => {
    const close = mock(async () => undefined);
    expect(await runThenClose(async () => 42, close)).toBe(42);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("rethrows the original work error when close also fails, reporting the close failure", async () => {
    const stderr = spyOn(console, "error").mockImplementation(() => undefined);
    const original = new Error("suite assertion failed");
    await expect(runThenClose(async () => { throw original; }, async () => { throw new Error("socket already closed"); })).rejects.toBe(original);
    expect(stderr).toHaveBeenCalledWith("MCP client close also failed: socket already closed");
    stderr.mockRestore();
  });

  test("fails a successful run whose close fails, keeping the close error as the cause", async () => {
    const closeError = new Error("transport error");
    const outcome = await runThenClose(async () => "done", async () => { throw closeError; }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome instanceof Error && outcome.message).toBe("MCP client failed to close: transport error");
    expect(outcome instanceof Error && outcome.cause).toBe(closeError);
  });
});
