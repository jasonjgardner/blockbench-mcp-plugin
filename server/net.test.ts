import { afterEach, describe, expect, test } from "bun:test";
import net, { type AddressInfo } from "node:net";
import { z } from "zod";
import { createTool, removeTool } from "@/lib/factories";
import { sessionManager } from "@/lib/sessions";
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
async function start(host?: string): Promise<NetServer[]> {
  const [servers, transports] = createNetServer(net, { port: 0, endpoint: "/bb-mcp", host, keepAlive: noKeepAlive });
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

/** Splits the bytes a connection received into consecutive responses framed by Content-Length. */
function splitResponses(raw: string): IHttpResponse[] {
  const responses: IHttpResponse[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const headEnd = raw.indexOf("\r\n\r\n", offset);
    if (headEnd === -1) break;
    const [statusLine = "", ...fields] = raw.slice(offset, headEnd).split("\r\n");
    const headers = Object.fromEntries(fields.map((field) => {
      const colon = field.indexOf(":");
      return [field.slice(0, colon).trim().toLowerCase(), field.slice(colon + 1).trim()];
    }));
    const length = Number(headers["content-length"] ?? 0);
    responses.push({ status: Number(statusLine.split(" ", 2)[1]), headers, body: raw.slice(headEnd + 4, headEnd + 4 + length) });
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
  /** Lets the tool finish with the text "released". */
  release(): void;
}

/** Registers, for one test, a tool that runs until `release()` is called. */
function registerWaitingTool(name: string): IWaitingTool {
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const state: IWaitingTool = { release: () => {}, started };
  createTool(name, {
    description: "Waits until released.",
    parameters: z.object({}),
    execute: () => new Promise((resolve) => {
      state.release = () => resolve("released");
      markStarted();
    }),
  });
  return state;
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
