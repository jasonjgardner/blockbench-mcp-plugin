import { afterEach, describe, expect, spyOn, test } from "bun:test";
import net, { type AddressInfo } from "node:net";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createTool, removeTool } from "@/lib/factories";
import { DEFAULT_MAX_SESSIONS, sessionManager, type ISessionConfig } from "@/lib/sessions";
import createNetServer, { type NetServer, type SessionTransports } from "@/server/net";
import { useGlobals } from "@/tests/helpers/globals";

useGlobals(() => ({
  Blockbench: { showQuickMessage: () => {} },
}));

const noKeepAlive = { enabled: false, idleTimeoutMs: 0, sseHeartbeatIntervalMs: 0 };
let running: NetServer[] = [];
let sessions: SessionTransports = new Map();

afterEach(() => {
  for (const server of running) server.close();
  running = [];
  // Sessions live in the process-wide manager; removing them closes their transports.
  for (const id of [...sessions.keys()]) sessionManager.remove(id);
  sessions = new Map();
});

/** Starts the plugin's HTTP server on free ports and waits until every listener is bound. */
async function start(host?: string, sessionConfig?: Partial<ISessionConfig>): Promise<NetServer[]> {
  const [servers, transports] = createNetServer(net, { port: 0, endpoint: "/bb-mcp", host, keepAlive: noKeepAlive, sessionConfig });
  running = servers;
  sessions = transports;
  await Promise.all(
    servers.map((server) => server.listening
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        server.once("listening", () => resolve());
        // An unavailable IPv6 loopback is tolerated by the server; do not hang on it.
        server.once("error", () => resolve());
      })),
  );
  return servers.filter((server) => server.listening);
}

function portOf(server: NetServer): number {
  return (server.address() as AddressInfo).port;
}

/** One HTTP response read off a connection. */
interface IHttpResponse {
  status: number;
  /** Header fields with lower-case names. */
  headers: Record<string, string>;
  body: string;
}

/**
 * Splits the bytes a connection received into consecutive final responses framed by
 * Content-Length. `methods` lists the requests' methods in order: a HEAD response has no
 * body whatever its Content-Length says. Interim `100 Continue` responses are skipped.
 */
function splitResponses(raw: string, methods: readonly string[] = []): IHttpResponse[] {
  const responses: IHttpResponse[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const headEnd = raw.indexOf("\r\n\r\n", offset);
    if (headEnd === -1) break;
    const [statusLine = "", ...fields] = raw.slice(offset, headEnd).split("\r\n");
    const status = Number(statusLine.split(" ", 2)[1]);
    const headers = Object.fromEntries(fields.map((field) => {
      const colon = field.indexOf(":");
      return [field.slice(0, colon).trim().toLowerCase(), field.slice(colon + 1).trim()];
    }));
    const length = status === 100 || methods[responses.length] === "HEAD" ? 0 : Number(headers["content-length"] ?? 0);
    if (status !== 100) responses.push({ status, headers, body: raw.slice(headEnd + 4, headEnd + 4 + length) });
    offset = headEnd + 4 + length;
  }
  return responses;
}

/** A raw HTTP/1.1 request with a Content-Length for `body`. */
function rawRequest(lines: string[], body = ""): string {
  return `${[...lines, `Content-Length: ${Buffer.byteLength(body)}`].join("\r\n")}\r\n\r\n${body}`;
}

/** Sends one raw HTTP/1.1 request to 127.0.0.1 on its own connection and returns the response. */
function request(port: number, lines: string[], body = ""): Promise<IHttpResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => socket.write(rawRequest([...lines, "Connection: close"], body)));
    let raw = "";
    socket.on("data", (chunk) => { raw += chunk.toString(); });
    socket.on("error", reject);
    socket.on("end", () => {
      const [response] = splitResponses(raw);
      if (response) resolve(response);
      else reject(new Error(`No HTTP response in "${raw.slice(0, 80)}"`));
    });
  });
}

interface IRawConnection {
  socket: net.Socket;
  /** Everything the server sent so far. */
  received(): string;
  /** Resolves when the server or the test closes the connection. */
  closed: Promise<void>;
}

/** Opens a raw keep-alive connection to 127.0.0.1 and collects everything the server sends. */
function rawConnection(port: number): IRawConnection {
  const socket = net.connect({ host: "127.0.0.1", port });
  let data = "";
  socket.on("data", (chunk) => { data += chunk.toString(); });
  socket.on("error", () => {});
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return { socket, received: () => data, closed };
}

/** Request line and headers of an MCP POST, with the session header when there is a session. */
function mcpPost(port: number, sessionId?: string): string[] {
  return [
    "POST /bb-mcp HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Content-Type: application/json",
    "Accept: application/json, text/event-stream",
    ...(sessionId ? [`Mcp-Session-Id: ${sessionId}`] : []),
  ];
}

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "net-test", version: "0" } },
});

/** Opens an MCP session and returns its id. */
async function initialize(port: number): Promise<string> {
  const response = await request(port, mcpPost(port), initializeBody);
  const sessionId = response.headers["mcp-session-id"];
  if (response.status !== 200 || !sessionId) throw new Error(`initialize failed: ${response.status} ${response.body}`);
  return sessionId;
}

/** A tools/call request body for `name` without arguments. */
function toolCall(id: number, name: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
}

interface IWaitingTool {
  /** Resolves once the tool is running. */
  readonly started: Promise<void>;
  /** Cancellation signal the tool received. */
  signal?: AbortSignal;
  /** Lets the tool finish with the text "released". */
  release(): void;
}

/** Registers, for one test, a tool that runs until `release()` is called or its signal aborts. */
function registerWaitingTool(name: string): IWaitingTool {
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const state: IWaitingTool = { release: () => {}, started };
  createTool(name, {
    description: "Waits until released or cancelled.",
    parameters: z.object({}),
    execute: (_args, context) => new Promise((resolve) => {
      state.signal = context?.signal;
      state.release = () => resolve("released");
      context?.signal?.addEventListener("abort", () => resolve("cancelled"));
      markStarted();
    }),
  });
  return state;
}

/** A notifications/cancelled body. */
function cancellation(params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params });
}

describe("createNetServer listen addresses", () => {
  test("listens only on loopback by default", async () => {
    const servers = await start();
    const addresses = servers.map((server) => (server.address() as AddressInfo).address);
    expect(addresses).toContain("127.0.0.1");
    for (const address of addresses) {
      expect(["127.0.0.1", "::1"]).toContain(address);
    }
  });

  test("listens on an explicit host", async () => {
    const [server] = await start("127.0.0.1");
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });
});

describe("createNetServer request checks", () => {
  test("serves requests with a loopback Host", async () => {
    const [server] = await start("127.0.0.1");
    const port = portOf(server);
    const res = await request(port, ["GET /bb-mcp/ready HTTP/1.1", `Host: localhost:${port}`]);
    expect(res.status).toBe(200);
  });

  test("rejects a DNS-rebound Host with 403", async () => {
    const [server] = await start("127.0.0.1");
    const port = portOf(server);
    const res = await request(port, ["GET /bb-mcp/health HTTP/1.1", `Host: evil.example:${port}`]);
    expect(res.status).toBe(403);
    expect(res.body).toContain("Host not allowed");
  });

  test("rejects a cross-site Origin before creating a session", async () => {
    const [server] = await start("127.0.0.1");
    const port = portOf(server);
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const res = await request(port, [
      "POST /bb-mcp HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Origin: http://evil.example",
      "Content-Type: application/json",
      "Accept: application/json, text/event-stream",
    ], init);
    expect(res.status).toBe(403);
    expect(res.body).toContain("Origin not allowed");
  });

  test("accepts a loopback browser Origin", async () => {
    const [server] = await start("127.0.0.1");
    const port = portOf(server);
    const res = await request(port, [
      "GET /bb-mcp/ready HTTP/1.1",
      `Host: localhost:${port}`,
      "Origin: http://localhost:6274",
    ]);
    expect(res.status).toBe(200);
  });
});

describe("createNetServer connections", () => {
  test("answers pipelined requests in order while an earlier one is still running", async () => {
    const tool = registerWaitingTool("net_test_wait_pipelined");
    try {
      const [server] = await start("127.0.0.1");
      const port = portOf(server);
      const sessionId = await initialize(port);
      const connection = rawConnection(port);
      connection.socket.write(rawRequest(mcpPost(port, sessionId), toolCall(5, "net_test_wait_pipelined")));
      await tool.started;
      // Sent once the call runs, so the server reads it while the call is pending.
      connection.socket.write(rawRequest(["GET /bb-mcp/ready HTTP/1.1", `Host: localhost:${port}`, "Connection: close"]));
      await Bun.sleep(50);
      expect(connection.received()).toBe("");

      tool.release();
      await connection.closed;
      const [call, ready] = splitResponses(connection.received());
      expect(JSON.parse(call?.body ?? "")).toMatchObject({ id: 5, result: { content: [{ type: "text", text: "released" }] } });
      expect(ready?.body).toBe('{"ready":true}');
    } finally {
      removeTool("net_test_wait_pipelined");
    }
  });
});

describe("createNetServer pending calls", () => {
  test("answers a cancelled call with -32800 and aborts the tool's signal", async () => {
    const tool = registerWaitingTool("net_test_cancel");
    try {
      const [server] = await start("127.0.0.1");
      const port = portOf(server);
      const sessionId = await initialize(port);
      const call = request(port, mcpPost(port, sessionId), toolCall(7, "net_test_cancel"));
      await tool.started;

      const cancel = await request(port, mcpPost(port, sessionId), cancellation({ requestId: 7, reason: "test" }));
      expect(cancel.status).toBe(202);

      const answered = await call;
      expect(answered.status).toBe(200);
      expect(JSON.parse(answered.body)).toMatchObject({ id: 7, error: { code: -32800 } });
      expect(tool.signal?.aborted).toBe(true);
    } finally {
      removeTool("net_test_cancel");
    }
  });

  test.each([
    ["requestId 0, which the SDK ignores", 0, { requestId: 0 }],
    ["a malformed reason, which the SDK rejects", 9, { requestId: 9, reason: 123 }],
  ])("a cancellation the SDK does not act on (%s) leaves the call to answer normally", async (_label, id, params) => {
    const tool = registerWaitingTool("net_test_not_cancelled");
    try {
      const [server] = await start("127.0.0.1");
      const port = portOf(server);
      const sessionId = await initialize(port);
      const connection = rawConnection(port);
      connection.socket.write(rawRequest([...mcpPost(port, sessionId), "Connection: close"], toolCall(id, "net_test_not_cancelled")));
      await tool.started;

      expect((await request(port, mcpPost(port, sessionId), cancellation(params))).status).toBe(202);
      await Bun.sleep(50);
      expect(connection.received()).toBe("");
      expect(tool.signal?.aborted).toBe(false);

      tool.release();
      await connection.closed;
      expect(JSON.parse(splitResponses(connection.received())[0]?.body ?? "")).toMatchObject({
        id,
        result: { content: [{ type: "text", text: "released" }] },
      });
    } finally {
      removeTool("net_test_not_cancelled");
    }
  });

  test("a batch keeps the result of a call that finished before its cancellation", async () => {
    const tool = registerWaitingTool("net_test_batch_wait");
    createTool("net_test_batch_quick", { description: "Answers at once.", parameters: z.object({}), execute: async () => "quick" });
    try {
      const [server] = await start("127.0.0.1");
      const port = portOf(server);
      const sessionId = await initialize(port);
      const call = request(port, mcpPost(port, sessionId), `[${toolCall(21, "net_test_batch_quick")},${toolCall(22, "net_test_batch_wait")}]`);
      await tool.started;
      // The quick call has answered; its result waits in the transport for the rest of the batch.
      await Bun.sleep(20);

      expect((await request(port, mcpPost(port, sessionId), cancellation({ requestId: 21 }))).status).toBe(202);
      expect((await request(port, mcpPost(port, sessionId), cancellation({ requestId: 22 }))).status).toBe(202);

      expect(JSON.parse((await call).body)).toEqual([
        expect.objectContaining({ id: 21, result: expect.objectContaining({ content: [{ type: "text", text: "quick" }] }) }),
        expect.objectContaining({ id: 22, error: expect.objectContaining({ code: -32800 }) }),
      ]);
    } finally {
      removeTool("net_test_batch_wait");
      removeTool("net_test_batch_quick");
    }
  });

  test("deleting a session with a pending call aborts the call and answers its POST", async () => {
    const tool = registerWaitingTool("net_test_wait_delete");
    try {
      const [server] = await start("127.0.0.1");
      const port = portOf(server);
      const sessionId = await initialize(port);
      const call = request(port, mcpPost(port, sessionId), toolCall(8, "net_test_wait_delete"));
      await tool.started;

      const deleted = await request(port, ["DELETE /bb-mcp HTTP/1.1", `Host: 127.0.0.1:${port}`, `Mcp-Session-Id: ${sessionId}`]);
      expect(deleted.status).toBe(200);

      const answered = await call;
      expect(answered.status).toBe(404);
      expect(answered.body).toContain("Session closed before the request completed");
      expect(tool.signal?.aborted).toBe(true);
    } finally {
      tool.release();
      removeTool("net_test_wait_delete");
    }
  });
});

describe("createNetServer session lifecycle", () => {
  test("closes the server of an initialize the transport refuses", async () => {
    const closes = spyOn(WebStandardStreamableHTTPServerTransport.prototype, "close");
    try {
      const [server] = await start("127.0.0.1");
      const port = portOf(server);
      const lines = mcpPost(port).map((line) => line.startsWith("Accept:") ? "Accept: application/json" : line);
      const refused = await request(port, lines, initializeBody);
      expect(refused.status).toBe(406);
      expect(closes).toHaveBeenCalledTimes(1);
      expect(sessions.size).toBe(0);
    } finally {
      closes.mockRestore();
    }
  });

  test("refuses an initialize sent as a notification without opening a session", async () => {
    const [server] = await start("127.0.0.1");
    const port = portOf(server);
    const before = sessionManager.getCount();
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "net-test", version: "0" } },
    });
    const refused = await request(port, mcpPost(port), notification);
    expect(refused.status).toBe(400);
    expect(sessions.size).toBe(0);
    expect(sessionManager.getCount()).toBe(before);
  });

  test("at the session limit, closes the least recently active idle session for a new client", async () => {
    try {
      const [server] = await start("127.0.0.1", { maxSessions: 2 });
      const port = portOf(server);
      const first = await initialize(port);
      await Bun.sleep(10);
      const second = await initialize(port);
      await Bun.sleep(10);
      const ping = await request(port, mcpPost(port, first), JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }));
      expect(ping.status).toBe(200);

      const third = await initialize(port);
      expect([...sessions.keys()].sort()).toEqual([first, third].sort());
      expect((await request(port, mcpPost(port, second), toolCall(3, "net_test_any"))).status).toBe(404);
    } finally {
      sessionManager.configure({ maxSessions: DEFAULT_MAX_SESSIONS });
    }
  });

  test("refuses a new client with 503 while every session at the limit has a request in flight", async () => {
    const tool = registerWaitingTool("net_test_busy");
    try {
      const [server] = await start("127.0.0.1", { maxSessions: 1 });
      const port = portOf(server);
      const sessionId = await initialize(port);
      const call = request(port, mcpPost(port, sessionId), toolCall(3, "net_test_busy"));
      await tool.started;

      const refused = await request(port, mcpPost(port), initializeBody);
      expect(refused.status).toBe(503);
      expect(refused.body).toContain("Too many MCP sessions: 1 are open and all are in use");
      expect([...sessions.keys()]).toEqual([sessionId]);

      tool.release();
      expect((await call).status).toBe(200);
    } finally {
      removeTool("net_test_busy");
      sessionManager.configure({ maxSessions: DEFAULT_MAX_SESSIONS });
    }
  });
});

/** Resolves once `condition` holds, polling every few milliseconds. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await Bun.sleep(5);
}

describe("createNetServer HTTP framing", () => {
  test("answers HEAD with headers only", async () => {
    const [server] = await start("127.0.0.1");
    const port = portOf(server);
    const response = await request(port, ["HEAD /bb-mcp/health HTTP/1.1", `Host: localhost:${port}`]);
    expect(response.status).toBe(200);
    expect(Number(response.headers["content-length"])).toBeGreaterThan(0);
    expect(response.body).toBe("");
  });

  test("sends 100 Continue before a body the client holds back", async () => {
    const [server] = await start("127.0.0.1");
    const port = portOf(server);
    const body = JSON.stringify({ probe: true });
    const connection = rawConnection(port);
    connection.socket.write([
      "POST /bb-mcp/ready HTTP/1.1",
      `Host: localhost:${port}`,
      "Content-Type: application/json",
      "Expect: 100-continue",
      "Connection: close",
      `Content-Length: ${Buffer.byteLength(body)}`,
    ].join("\r\n") + "\r\n\r\n");
    await until(() => connection.received().length > 0);
    expect(connection.received()).toBe("HTTP/1.1 100 Continue\r\n\r\n");

    connection.socket.write(body);
    await connection.closed;
    const final = connection.received().slice("HTTP/1.1 100 Continue\r\n\r\n".length);
    expect(final.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
    expect(final).toContain('{"ready":true}');
  });

  test("refuses an endless header section with 431 and closes the connection", async () => {
    const [server] = await start("127.0.0.1");
    const port = portOf(server);
    const connection = rawConnection(port);
    connection.socket.write(`GET /bb-mcp/ready HTTP/1.1\r\nX-Filler: ${"a".repeat(70 * 1024)}`);
    await connection.closed;
    expect(connection.received().startsWith("HTTP/1.1 431 Request Header Fields Too Large\r\n")).toBe(true);
  });

  test("a HEAD pipelined behind a pending POST leaves the POST its body and has none itself", async () => {
    const tool = registerWaitingTool("net_test_wait_head");
    try {
      const [server] = await start("127.0.0.1");
      const port = portOf(server);
      const sessionId = await initialize(port);
      const connection = rawConnection(port);
      connection.socket.write(rawRequest(mcpPost(port, sessionId), toolCall(6, "net_test_wait_head")));
      await tool.started;
      connection.socket.write(rawRequest(["HEAD /bb-mcp/health HTTP/1.1", `Host: localhost:${port}`, "Connection: close"]));
      await Bun.sleep(50);

      tool.release();
      await connection.closed;
      const [call, health] = splitResponses(connection.received(), ["POST", "HEAD"]);
      expect(JSON.parse(call?.body ?? "")).toMatchObject({ id: 6, result: { content: [{ type: "text", text: "released" }] } });
      expect(health?.status).toBe(200);
      expect(Number(health?.headers["content-length"])).toBeGreaterThan(0);
      expect(connection.received().endsWith("\r\n\r\n")).toBe(true);
    } finally {
      removeTool("net_test_wait_head");
    }
  });

  test("each pipelined request that expects 100-continue gets its own interim response, in order", async () => {
    const [server] = await start("127.0.0.1");
    const port = portOf(server);
    const body = JSON.stringify({ probe: true });
    const head = (close: boolean): string => [
      "POST /bb-mcp/ready HTTP/1.1",
      `Host: localhost:${port}`,
      "Content-Type: application/json",
      "Expect: 100-continue",
      ...(close ? ["Connection: close"] : []),
      `Content-Length: ${Buffer.byteLength(body)}`,
    ].join("\r\n") + "\r\n\r\n";
    // A status line can follow a body directly, so find them anywhere.
    const statuses = (): string[] => connection.received().match(/HTTP\/1\.1 \d{3} [^\r]*/g) ?? [];
    const connection = rawConnection(port);

    connection.socket.write(head(false));
    await until(() => statuses().length === 1);
    connection.socket.write(body + head(true));
    await until(() => statuses().length === 3);
    expect(statuses()).toEqual(["HTTP/1.1 100 Continue", "HTTP/1.1 200 OK", "HTTP/1.1 100 Continue"]);

    connection.socket.write(body);
    await connection.closed;
    expect(statuses()).toEqual(["HTTP/1.1 100 Continue", "HTTP/1.1 200 OK", "HTTP/1.1 100 Continue", "HTTP/1.1 200 OK"]);
    expect(splitResponses(connection.received()).map((response) => response.body)).toEqual(['{"ready":true}', '{"ready":true}']);
  });
});
