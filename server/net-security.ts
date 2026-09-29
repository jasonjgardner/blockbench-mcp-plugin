/**
 * Network exposure policy for the MCP HTTP server.
 *
 * The MCP Streamable HTTP transport asks local servers to bind to localhost and to validate the
 * `Origin` header, so a web page cannot reach the server through DNS rebinding. These helpers are
 * pure (no Blockbench globals) so they can be unit tested and reused by `server/net.ts`.
 */

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
