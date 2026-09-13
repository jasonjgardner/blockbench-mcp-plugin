import { version } from "@/package.json" assert { type: "json" };

/** Bundler build profile: production builds enable release-only runtime checks. */
export type BuildMode = "production" | "development";

declare const __MCP_BUILD_ID__: string;
declare const __MCP_BUILD_MODE__: BuildMode;

/** Source fingerprint embedded by the bundler; unbundled test imports use development. */
export const BUILD_ID = typeof __MCP_BUILD_ID__ === "string" ? __MCP_BUILD_ID__ : "development";
/** Build profile used for runtime release checks; tests/default imports are development. */
export const BUILD_MODE: BuildMode = typeof __MCP_BUILD_MODE__ === "string" ? __MCP_BUILD_MODE__ : "development";
/** Plugin version from package.json, reported to MCP clients and release evidence. */
export const VERSION = version;
/** Status for tools that are production-ready. */
export const STATUS_STABLE = "stable";
/** Status for tools whose contract may still change. */
export const STATUS_EXPERIMENTAL = "experimental";

/** Default HTTP port of the plugin's MCP server (Settings > General > MCP port). */
export const DEFAULT_MCP_PORT = 3000;
/** Default MCP endpoint path served by the plugin (Settings > General > MCP endpoint). */
export const DEFAULT_MCP_ENDPOINT = "/bb-mcp";

/**
 * Tolerance for degenerate geometry checks (zero-length edges, collinear
 * points, zero-area projections). Values below this are treated as zero.
 */
export const GEOMETRY_EPSILON = 1e-8;

/** Upper bound for per-face subdivision cuts; keeps generated grids interactive. */
export const MAX_SUBDIVISION_CUTS = 10;
