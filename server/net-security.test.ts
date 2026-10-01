import { describe, expect, test } from "bun:test";
import {
  checkRequest,
  formatHostForUrl,
  hostnameFromHostHeader,
  isLocalNetworkHostname,
  isLoopbackHostname,
  resolveListenPlan,
  resolveServerAddress,
  type IListenPlan,
} from "@/server/net-security";

const loopbackPlan: IListenPlan = { hosts: ["127.0.0.1", "::1"], loopbackOnly: true };
const exposedPlan: IListenPlan = { hosts: ["0.0.0.0"], loopbackOnly: false };

describe("resolveListenPlan", () => {
  test("defaults to both loopback addresses", () => {
    for (const value of ["localhost", "LocalHost", " localhost ", "", undefined, null, 3000]) {
      expect(resolveListenPlan(value)).toEqual(loopbackPlan);
    }
  });

  test("uses an explicit loopback address as given", () => {
    expect(resolveListenPlan("127.0.0.1")).toEqual({ hosts: ["127.0.0.1"], loopbackOnly: true });
    expect(resolveListenPlan("[::1]")).toEqual({ hosts: ["::1"], loopbackOnly: true });
  });

  test("marks all-interface and LAN addresses as exposed", () => {
    expect(resolveListenPlan("0.0.0.0")).toEqual({ hosts: ["0.0.0.0"], loopbackOnly: false });
    expect(resolveListenPlan("::")).toEqual({ hosts: ["::"], loopbackOnly: false });
    expect(resolveListenPlan("192.168.1.20").loopbackOnly).toBe(false);
  });
});

describe("isLoopbackHostname", () => {
  test("accepts localhost, 127.0.0.0/8 and ::1", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopbackHostname(host)).toBe(true);
    }
  });

  test("rejects other names and addresses", () => {
    for (const host of ["evil.example", "localhost.evil.example", "0.0.0.0", "::", "192.168.1.20", "128.0.0.1"]) {
      expect(isLoopbackHostname(host)).toBe(false);
    }
  });
});

describe("hostnameFromHostHeader", () => {
  test("drops the port and IPv6 brackets", () => {
    expect(hostnameFromHostHeader("localhost:3000")).toBe("localhost");
    expect(hostnameFromHostHeader("127.0.0.1:3000")).toBe("127.0.0.1");
    expect(hostnameFromHostHeader("[::1]:3000")).toBe("::1");
    expect(hostnameFromHostHeader("localhost")).toBe("localhost");
  });
});

describe("checkRequest", () => {
  test("allows MCP clients that send a loopback Host and no Origin", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      expect(checkRequest({ host }, loopbackPlan)).toEqual({ allowed: true });
    }
    expect(checkRequest({}, loopbackPlan)).toEqual({ allowed: true });
  });

  test("allows loopback browser origins on any port", () => {
    expect(checkRequest({ host: "localhost:3000", origin: "http://localhost:6274" }, loopbackPlan)).toEqual({ allowed: true });
    expect(checkRequest({ host: "localhost:3000", origin: "http://[::1]:5173" }, loopbackPlan)).toEqual({ allowed: true });
  });

  test("rejects a rebound request that carries another site's Host", () => {
    const result = checkRequest({ host: "evil.example:3000" }, loopbackPlan);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("evil.example");
  });

  test("rejects foreign, malformed and null origins", () => {
    for (const origin of ["http://evil.example", "http://localhost.evil.example:3000", "null", "not a url"]) {
      expect(checkRequest({ host: "localhost:3000", origin }, loopbackPlan).allowed).toBe(false);
    }
  });

  test("when exposed on purpose, skips the Host check but still rejects foreign origins", () => {
    expect(checkRequest({ host: "192.168.1.20:3000" }, exposedPlan)).toEqual({ allowed: true });
    expect(checkRequest({ host: "192.168.1.20:3000", origin: "http://evil.example" }, exposedPlan).allowed).toBe(false);
  });
});

test("formatHostForUrl brackets IPv6 literals", () => {
  expect(formatHostForUrl("127.0.0.1")).toBe("127.0.0.1");
  expect(formatHostForUrl("::1")).toBe("[::1]");
});

describe("resolveServerAddress", () => {
  test("keeps valid settings and normalizes the endpoint's slashes", () => {
    expect(resolveServerAddress(3100, "/bb-mcp")).toEqual({ port: 3100, endpoint: "/bb-mcp", warnings: [] });
    expect(resolveServerAddress("3100", " bb-mcp/ ").endpoint).toBe("/bb-mcp");
    expect(resolveServerAddress(3000, "//mcp/v1//").endpoint).toBe("/mcp/v1");
  });

  test("uses the defaults silently when a setting is unset", () => {
    expect(resolveServerAddress(undefined, "")).toEqual({ port: 3000, endpoint: "/bb-mcp", warnings: [] });
  });

  test("replaces an unusable port with the default and says so", () => {
    for (const port of [0, -1, 3000.5, 65536, "http", Number.NaN]) {
      const address = resolveServerAddress(port, "/bb-mcp");
      expect(address.port).toBe(3000);
      expect(address.warnings).toHaveLength(1);
    }
  });

  test("replaces an endpoint with spaces, a query or a fragment with the default and says so", () => {
    for (const endpoint of ["/bb mcp", "/bb-mcp?x=1", "/bb-mcp#top", "/café"]) {
      const address = resolveServerAddress(3000, endpoint);
      expect(address.endpoint).toBe("/bb-mcp");
      expect(address.warnings).toEqual([expect.stringContaining("is not a URL path")]);
    }
  });
});

describe("isLocalNetworkHostname", () => {
  test("flags this computer, private networks and local names as URL parsers print them", () => {
    const local = [
      "localhost", "LOCALHOST.", "printer.localhost", "nas.local", "intranet",
      "router.lan", "db.internal", "nas.home.arpa", "HOME.ARPA.lan",
      "127.0.0.1", "0.0.0.0", "10.1.2.3", "100.64.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
      "192.168.1.20", "224.0.0.1", "255.255.255.255",
      "[::1]", "[::]", "[::ffff:7f00:1]", "[fd12:3456::1]", "[fe80::1]", "[fec0::1]", "[feff::1]", "[ff02::1]",
    ];
    for (const host of local) expect([host, isLocalNetworkHostname(host)]).toEqual([host, true]);
    // The WHATWG parser turns decimal and hex IPv4 spellings into dotted decimal first.
    expect(isLocalNetworkHostname(new URL("http://2130706433/").hostname)).toBe(true);
    expect(isLocalNetworkHostname(new URL("http://0x7f.1/").hostname)).toBe(true);
  });

  test("allows public names and addresses", () => {
    const publicHosts = [
      "raw.githubusercontent.com", "example.com", "lanparty.example", "internal.example.com", "home.arpa.example",
      "8.8.8.8", "172.32.0.1", "100.128.0.1", "[2606:4700::1111]", "[fe7f::1]",
    ];
    for (const host of publicHosts) {
      expect([host, isLocalNetworkHostname(host)]).toEqual([host, false]);
    }
  });
});
