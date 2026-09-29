import { afterEach, describe, expect, test } from "bun:test";
import net, { type AddressInfo } from "node:net";
import createNetServer, { type NetServer } from "@/server/net";
import { useGlobals } from "@/tests/helpers/globals";

useGlobals(() => ({
  Blockbench: { showQuickMessage: () => {} },
}));

const noKeepAlive = { enabled: false, idleTimeoutMs: 0, sseHeartbeatIntervalMs: 0 };
let running: NetServer[] = [];

afterEach(() => {
  for (const server of running) server.close();
  running = [];
});

/** Starts the plugin's HTTP server on free ports and waits until every listener is bound. */
async function start(host?: string): Promise<NetServer[]> {
  const [servers] = createNetServer(net, { port: 0, endpoint: "/bb-mcp", host, keepAlive: noKeepAlive });
  running = servers;
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

/** Sends one raw HTTP/1.1 request to 127.0.0.1 and returns the status code and body. */
function request(port: number, lines: string[], body = ""): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      const head = [...lines, "Connection: close", `Content-Length: ${Buffer.byteLength(body)}`].join("\r\n");
      socket.write(`${head}\r\n\r\n${body}`);
    });
    let raw = "";
    socket.on("data", (chunk) => { raw += chunk.toString(); });
    socket.on("error", reject);
    socket.on("end", () => {
      const status = Number(raw.split(" ", 2)[1]);
      resolve({ status, body: raw.slice(raw.indexOf("\r\n\r\n") + 4) });
    });
  });
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
