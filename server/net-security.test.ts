import { describe, expect, test } from "bun:test";
import {
  checkRequest,
  formatHostForUrl,
  hostnameFromHostHeader,
  isLoopbackHostname,
  resolveListenPlan,
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
