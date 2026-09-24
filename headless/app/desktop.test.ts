import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { candidatePaths, launchBlockbench, launchCommand, launchEnv, locateBlockbench, waitForEndpoint } from "./desktop";

const none = (): null => null;

describe("candidatePaths", () => {
  test("Windows checks the per-user installer folder first", () => {
    const paths = candidatePaths("win32", { LOCALAPPDATA: "C:/Users/me/AppData/Local", ProgramFiles: "C:/Program Files" });
    expect(paths[0]?.replace(/\\/g, "/")).toBe("C:/Users/me/AppData/Local/Programs/Blockbench/Blockbench.exe");
    expect(paths).toHaveLength(2);
  });

  test("macOS looks for the app bundle", () => {
    expect(candidatePaths("darwin", { HOME: "/Users/me" })[0]).toBe("/Applications/Blockbench.app");
  });
});

describe("locateBlockbench", () => {
  const existing = (paths: string[]) => (path: string) => paths.includes(path);

  test("an explicit path wins when it exists", () => {
    expect(locateBlockbench("/x/bb", "linux", { BLOCKBENCH_PATH: "/y/bb" }, existing(["/x/bb", "/y/bb"]), none)).toBe("/x/bb");
  });

  test("falls back to $BLOCKBENCH_PATH, then PATH, then install folders", () => {
    expect(locateBlockbench(undefined, "linux", { BLOCKBENCH_PATH: "/y/bb" }, existing(["/y/bb"]), none)).toBe("/y/bb");
    expect(locateBlockbench(undefined, "linux", {}, existing(["/usr/local/bin/blockbench"]), () => "/usr/local/bin/blockbench")).toBe("/usr/local/bin/blockbench");
    expect(locateBlockbench(undefined, "linux", { HOME: "/h" }, existing(["/snap/bin/blockbench"]), none)).toBe("/snap/bin/blockbench");
  });

  test("a missing explicit path is an error, not a silent fallback to another install", () => {
    expect(() => locateBlockbench("/missing", "linux", { BLOCKBENCH_PATH: "/y/bb" }, existing(["/y/bb"]), none)).toThrow(/does not exist/);
  });

  test("returns undefined when nothing is installed", () => {
    expect(locateBlockbench(undefined, "win32", { LOCALAPPDATA: "C:/L" }, () => false, none)).toBeUndefined();
  });
});

describe("launchCommand", () => {
  test("passes the file last so a running instance opens it", () => {
    expect(launchCommand("C:/BB/Blockbench.exe", "D:/m/chair.bbmodel", "win32")).toEqual({ command: "C:/BB/Blockbench.exe", args: ["D:/m/chair.bbmodel"] });
    expect(launchCommand("/usr/bin/blockbench", undefined, "linux")).toEqual({ command: "/usr/bin/blockbench", args: [] });
  });

  test("macOS app bundles start through open -a, with or without a trailing slash", () => {
    expect(launchCommand("/Applications/Blockbench.app", "/m/chair.bbmodel", "darwin")).toEqual({ command: "open", args: ["-a", "/Applications/Blockbench.app", "/m/chair.bbmodel"] });
    expect(launchCommand("/Applications/Blockbench.app/", undefined, "darwin")).toEqual({ command: "open", args: ["-a", "/Applications/Blockbench.app"] });
  });

  test("the app never inherits ELECTRON_RUN_AS_NODE from an Electron-based MCP host", () => {
    expect(launchEnv({ ELECTRON_RUN_AS_NODE: "1", PATH: "/bin", EMPTY: undefined })).toEqual({ PATH: "/bin" });
  });
});

describe("launchBlockbench", () => {
  test("a missing executable is an error", async () => {
    await expect(launchBlockbench(join(import.meta.dir, "no-such-blockbench.exe"), undefined)).rejects.toThrow(/Could not start Blockbench/);
  });

  test("an app that exits with an error right away is reported, not called launched", async () => {
    await expect(launchBlockbench(process.execPath, join(import.meta.dir, "no-such-script.ts"))).rejects.toThrow(/exited right after starting/);
  });
});

describe("waitForEndpoint", () => {
  test("the plugin's JSON-RPC error to a bare GET counts as up", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" }, id: null }, { status: 400 }) });
    try {
      expect((await waitForEndpoint(`http://localhost:${server.port}/bb-mcp`, 2000)).reachable).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("some other server on the port does not count", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("<html>dev server</html>", { headers: { "content-type": "text/html" } }) });
    try {
      expect((await waitForEndpoint(`http://localhost:${server.port}/bb-mcp`, 700, 200)).reachable).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("gives up after the timeout when nothing listens", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = server.port;
    server.stop(true);
    const result = await waitForEndpoint(`http://localhost:${port}/bb-mcp`, 600, 200);
    expect(result.reachable).toBe(false);
    expect(result.waited_ms).toBeLessThan(3000);
  });
});
