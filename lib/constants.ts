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

/**
 * View reference that targets the viewport the user last interacted with.
 * Deliberately not a Blockbench preview ID: Blockbench names its primary
 * viewport `main`, which stays addressable by that ID through `list_views`.
 */
export const ACTIVE_VIEW_ID = "active";
/** `copy_view` value that leaves a new offscreen view at Blockbench's default angle. */
export const NO_COPY_VIEW_ID = "none";
/** View references with special meaning that can never name an offscreen view. */
export const RESERVED_VIEW_IDS: readonly string[] = [ACTIVE_VIEW_ID, NO_COPY_VIEW_ID];
/**
 * Upper bound on plugin-owned offscreen views. Every view holds its own WebGL
 * context and browsers cap those per page (about 16 in Chromium), which
 * Blockbench already shares with its main, split-screen, and media previews.
 */
export const MAX_OFFSCREEN_VIEWS = 4;
/** Smallest accepted offscreen view edge in pixels. */
export const MIN_OFFSCREEN_VIEW_SIZE = 16;
/** Largest accepted offscreen view edge in pixels; bounds GPU memory and base64 payload size. */
export const MAX_OFFSCREEN_VIEW_SIZE = 2048;
/** Default offscreen view width in pixels. */
export const DEFAULT_OFFSCREEN_VIEW_WIDTH = 1024;
/** Default offscreen view height in pixels. */
export const DEFAULT_OFFSCREEN_VIEW_HEIGHT = 768;

/**
 * ID of the plugin-registered Blockbench mode in which agents work without the
 * active format's geometry guardrails (cube size limiter, rotation limit and
 * snapping, integer sizes). Tools gated to `edit` should also accept this mode.
 */
export const SCRATCHPAD_MODE_ID = "ai_scratchpad";
/** Setting toggle (Settings > General) that registers the AI Scratchpad mode. */
export const SETTING_SCRATCHPAD_ENABLED = "mcp_ai_scratchpad_enabled";
/** Setting toggle (Settings > General) that stamps AI usage onto projects edited through MCP tools. */
export const SETTING_DISCLOSE_AI_USAGE = "mcp_disclose_ai_usage";
/** `ModelProject` boolean property set once any MCP tool writes to the project. */
export const AI_USED_PROPERTY = "ai_used";
/** `ModelProject` string property listing the distinct MCP client names that wrote to the project. */
export const AI_AGENTS_PROPERTY = "ai_agents";
