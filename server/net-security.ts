/**
 * Network exposure policy for the MCP HTTP server.
 *
 * The MCP Streamable HTTP transport asks local servers to bind to localhost and to validate the
 * `Origin` header, so a web page cannot reach the server through DNS rebinding. These helpers are
 * pure (no Blockbench globals) so they can be unit tested and reused by `server/net.ts`.
 */

import { DEFAULT_MCP_ENDPOINT, DEFAULT_MCP_PORT } from "@/lib/constants";

/** `mcp_host` setting value meaning "this computer only": listen on 127.0.0.1 and ::1. */
export const LOOPBACK_HOST_SETTING = "localhost";

/** Where the server listens, derived from the `mcp_host` setting. */
export interface IListenPlan {
  /** One listener per address, each passed to `server.listen(port, host)`. */
  hosts: string[];
  /** True when every listener only accepts connections from this computer. */
  loopbackOnly: boolean;
}

export type RequestCheck = { allowed: true } | { allowed: false; reason: string };

function stripBrackets(value: string): string {
  return value.replace(/^\[(.*)\]$/, "$1");
}

/** Whether a hostname or IP literal (optionally in brackets) names this computer. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = stripBrackets(hostname.trim().toLowerCase());
  if (host === "localhost" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Whether a URL hostname names this computer or a private or local network, which a tool must
 * not fetch for a client: loopback, 0.0.0.0/8, RFC 1918, carrier-grade NAT, link-local (cloud
 * metadata endpoints), multicast and reserved IPv4; IPv6 forms starting with `::` (unspecified,
 * loopback, IPv4-mapped), unique-local, link-local, site-local and multicast; names under
 * `.localhost`, `.local`, `.lan`, `.internal` and `.home.arpa`, and single-label names that the
 * local network resolves. The URL parser has already normalized IPv4 spellings such as
 * `2130706433`. A public name that resolves to a private address is not detected here.
 */
export function isLocalNetworkHostname(hostname: string): boolean {
  const host = stripBrackets(hostname.trim().toLowerCase()).replace(/\.$/, "");
  if (isLoopbackHostname(host)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 0 || a === 10 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // fc00::/7 unique-local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
  if (host.includes(":")) return host.startsWith("::") || /^(f[cd]|fe[89a-f]|ff)/.test(host);
  return !host.includes(".") || /\.(localhost|local|lan|internal|home\.arpa)$/.test(host);
}

/**
 * Resolves the `mcp_host` setting. Empty or `localhost` (the default) listens on both loopback
 * addresses so `http://localhost:<port>` works whichever address the client resolves first.
 * Any other value is used as given, e.g. `0.0.0.0` or `::` to accept remote connections on purpose.
 */
export function resolveListenPlan(setting: unknown): IListenPlan {
  const raw = typeof setting === "string" ? setting.trim() : "";
  if (raw === "" || raw.toLowerCase() === LOOPBACK_HOST_SETTING) {
    return { hosts: ["127.0.0.1", "::1"], loopbackOnly: true };
  }
  const host = stripBrackets(raw);
  return { hosts: [host], loopbackOnly: isLoopbackHostname(host) };
}

/** Port and endpoint the server uses, resolved from the `mcp_port` and `mcp_endpoint` settings. */
export interface IServerAddress {
  port: number;
  endpoint: string;
  /** One message per setting whose invalid value was replaced by the default. */
  warnings: string[];
}

/** An endpoint is a plain URL path: RFC 3986 path characters, no query, fragment or spaces. */
const ENDPOINT_PATTERN = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * Resolves the `mcp_port` and `mcp_endpoint` settings. The port must be an integer from 1 to 65535:
 * `listen` throws on anything else and the plugin would fail to load. The endpoint gets one leading
 * slash and no trailing ones, since requests are matched against it exactly. Unset values use the
 * defaults silently; invalid ones use them with a warning.
 */
export function resolveServerAddress(portSetting: unknown, endpointSetting: unknown): IServerAddress {
  const warnings: string[] = [];
  const port = Number(portSetting);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;
  if (!validPort && !isUnset(portSetting)) {
    warnings.push(`MCP port "${String(portSetting)}" is not a whole number from 1 to 65535; using ${DEFAULT_MCP_PORT}.`);
  }
  const endpoint = typeof endpointSetting === "string"
    ? `/${endpointSetting.trim().replace(/^\/+|\/+$/g, "")}`
    : "";
  const validEndpoint = ENDPOINT_PATTERN.test(endpoint);
  if (!validEndpoint && !isUnset(endpointSetting)) {
    warnings.push(`MCP endpoint "${String(endpointSetting)}" is not a URL path like ${DEFAULT_MCP_ENDPOINT}; using ${DEFAULT_MCP_ENDPOINT}.`);
  }
  return {
    port: validPort ? port : DEFAULT_MCP_PORT,
    endpoint: validEndpoint && !isUnset(endpointSetting) ? endpoint : DEFAULT_MCP_ENDPOINT,
    warnings,
  };
}

/** Hostname part of a `Host` header: `localhost:3000` → `localhost`, `[::1]:3000` → `::1`. */
export function hostnameFromHostHeader(value: string): string {
  const header = value.trim();
  if (header.startsWith("[")) {
    const end = header.indexOf("]");
    return end > 0 ? header.slice(1, end) : header;
  }
  const colon = header.lastIndexOf(":");
  return colon > -1 && header.indexOf(":") === colon ? header.slice(0, colon) : header;
}

/**
 * Rejects requests a browser could send on behalf of another site.
 *
 * - `Origin`, when present, must be a loopback origin (any port), so a page on another site cannot
 *   drive the server, including after rebinding its DNS name to 127.0.0.1. `Origin: null` is rejected.
 * - `Host`, when listening on loopback only, must be a loopback name. A rebound request carries the
 *   attacker's hostname, so it is refused even if a client omitted `Origin`.
 *
 * Non-browser MCP clients send `Host: localhost:<port>` (or the IP) and no `Origin`, so they pass.
 */
export function checkRequest(headers: Record<string, string>, plan: IListenPlan): RequestCheck {
  const origin = headers["origin"];
  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      originHost = null;
    }
    if (!originHost || !isLoopbackHostname(originHost)) {
      return { allowed: false, reason: `Origin not allowed: ${origin}` };
    }
  }

  if (plan.loopbackOnly) {
    const host = headers["host"];
    if (host !== undefined && !isLoopbackHostname(hostnameFromHostHeader(host))) {
      return { allowed: false, reason: `Host not allowed: ${host}` };
    }
  }

  return { allowed: true };
}

/** `127.0.0.1` → `127.0.0.1`, `::1` → `[::1]`, for URLs in log messages. */
export function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
