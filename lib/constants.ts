import { version } from "../package.json" assert { type: "json" };

declare const __MCP_BUILD_ID__: string;
declare const __MCP_BUILD_MODE__: "production" | "development";

/** Source fingerprint embedded by the bundler; unbundled test imports use development. */
export const BUILD_ID = typeof __MCP_BUILD_ID__ === "string" ? __MCP_BUILD_ID__ : "development";
/** Build profile used for runtime release checks; tests/default imports are development. */
export const BUILD_MODE = typeof __MCP_BUILD_MODE__ === "string" ? __MCP_BUILD_MODE__ : "development";
export const VERSION = version;
export const STATUS_STABLE = "stable";
export const STATUS_EXPERIMENTAL = "experimental";
