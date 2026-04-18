import { VERSION } from "@/lib/constants";
import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

export interface PromptManifest {
  version: string;
  generatedAt: string;
  prompts: Record<string, string>;
}

// ============================================================================
// Constants
// ============================================================================

const CDN_BASE_URL =
  "https://cdn.jsdelivr.net/gh/jasonjgardner/blockbench-mcp-plugin";
const MANIFEST_PATH = "prompts/manifest.json";

const STORAGE_KEY_MANIFEST = "bbmcp_prompt_manifest";
const STORAGE_KEY_VERSION = "bbmcp_prompt_manifest_version";
const STORAGE_KEY_OVERRIDES = "bbmcp_prompt_overrides";

// ============================================================================
// State
// ============================================================================

let manifest: PromptManifest | null = null;
let overrides: Record<string, string> = {};
let initialized = false;

// ============================================================================
// localStorage helpers (safe for CLI environments)
// ============================================================================

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function storageGet(key: string): string | null {
  if (!hasLocalStorage()) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    // QuotaExceededError — continue with in-memory only
    console.warn("[MCP] localStorage write failed:", err);
  }
}

function storageRemove(key: string): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

// ============================================================================
// CDN helpers
// ============================================================================

function getManifestUrl(): string {
  return `${CDN_BASE_URL}@v${VERSION}/${MANIFEST_PATH}`;
}

const promptManifestSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  prompts: z.record(z.string(), z.string()),
});

async function fetchManifestFromCDN(): Promise<PromptManifest> {
  const url = getManifestUrl();
  console.log(`[MCP] Fetching prompt manifest from ${url}`);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const json = await response.json();
  const result = promptManifestSchema.safeParse(json);

  if (!result.success) {
    throw new Error(`Invalid manifest: ${result.error.message}`);
  }

  return result.data;
}

// ============================================================================
// Cache helpers
// ============================================================================

function loadCachedManifest(): PromptManifest | null {
  const raw = storageGet(STORAGE_KEY_MANIFEST);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PromptManifest;
    if (parsed.prompts && typeof parsed.prompts === "object") {
      return parsed;
    }
  } catch {
    // Corrupted cache — clear it
    storageRemove(STORAGE_KEY_MANIFEST);
    storageRemove(STORAGE_KEY_VERSION);
  }

  return null;
}

function cacheManifest(m: PromptManifest): void {
  storageSet(STORAGE_KEY_MANIFEST, JSON.stringify(m));
  storageSet(STORAGE_KEY_VERSION, VERSION);
}

function loadOverrides(): Record<string, string> {
  const raw = storageGet(STORAGE_KEY_OVERRIDES);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed;
    }
  } catch {
    storageRemove(STORAGE_KEY_OVERRIDES);
  }

  return {};
}

function persistOverrides(): void {
  if (Object.keys(overrides).length === 0) {
    storageRemove(STORAGE_KEY_OVERRIDES);
  } else {
    storageSet(STORAGE_KEY_OVERRIDES, JSON.stringify(overrides));
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the prompt loader. Loads overrides from localStorage,
 * checks the cache, and fetches from CDN if needed.
 *
 * Call during plugin `onload()` before the server starts accepting requests.
 *
 * @param cdnEnabled - Whether to fetch from CDN (default: true).
 *   When false, only localStorage cache is used.
 */
export async function initPromptLoader(
  cdnEnabled: boolean = true
): Promise<void> {
  // Load user overrides
  overrides = loadOverrides();

  // Check cache version
  const cachedVersion = storageGet(STORAGE_KEY_VERSION);
  const cacheHit = cachedVersion === VERSION;

  if (cacheHit) {
    manifest = loadCachedManifest();
    if (manifest) {
      console.log(
        `[MCP] Prompt manifest loaded from cache (v${VERSION}, ${Object.keys(manifest.prompts).length} prompts)`
      );
      initialized = true;
      return;
    }
  }

  // Cache miss or stale — fetch from CDN if enabled
  if (cdnEnabled) {
    try {
      manifest = await fetchManifestFromCDN();
      cacheManifest(manifest);
      console.log(
        `[MCP] Prompt manifest fetched from CDN (v${VERSION}, ${Object.keys(manifest.prompts).length} prompts)`
      );
      initialized = true;
      return;
    } catch (err) {
      console.error("[MCP] CDN fetch failed:", err);
    }
  }

  // CDN failed or disabled — try stale cache as last resort
  const staleManifest = loadCachedManifest();
  if (staleManifest) {
    manifest = staleManifest;
    const staleVersion = cachedVersion ?? "unknown";
    console.warn(
      `[MCP] Using stale cached manifest (cached: v${staleVersion}, current: v${VERSION})`
    );
    initialized = true;
    return;
  }

  // Nothing available
  manifest = null;
  initialized = true;
  console.error(
    "[MCP] No prompt manifest available — prompts will return empty content"
  );
}

/**
 * Get prompt content by name.
 * Priority: user override > manifest > empty string.
 * Synchronous — the manifest should already be loaded via `initPromptLoader()`.
 */
export function getPromptContent(name: string): string {
  if (!initialized) {
    console.warn(
      "[MCP] getPromptContent called before initPromptLoader — returning empty"
    );
    return "";
  }

  // User override takes priority
  const override = overrides[name];
  if (override !== undefined && override !== "") {
    return override;
  }

  // Fall back to manifest
  return manifest?.prompts[name] ?? "";
}

/**
 * Set a user override for a specific prompt. Persists to localStorage.
 */
export function setPromptOverride(name: string, content: string): void {
  overrides = { ...overrides, [name]: content };
  persistOverrides();
}

/**
 * Remove a user override, reverting to CDN/cached content.
 */
export function clearPromptOverride(name: string): void {
  const { [name]: _, ...rest } = overrides;
  overrides = rest;
  persistOverrides();
}

/**
 * Check if a specific prompt has a user override.
 */
export function hasPromptOverride(name: string): boolean {
  return name in overrides && overrides[name] !== "";
}

/**
 * Get all current user overrides.
 */
export function getPromptOverrides(): Record<string, string> {
  return { ...overrides };
}

/**
 * Get all available prompt names from the manifest.
 */
export function getAvailablePromptNames(): string[] {
  if (!manifest) return [];
  return Object.keys(manifest.prompts);
}

/**
 * Get the loaded manifest (if any). For UI display.
 */
export function getManifest(): PromptManifest | null {
  if (!manifest) return null;
  return { ...manifest, prompts: { ...manifest.prompts } };
}

/**
 * Force re-fetch from CDN, bypassing cache.
 */
export async function refreshFromCDN(): Promise<void> {
  try {
    manifest = await fetchManifestFromCDN();
    cacheManifest(manifest);
    console.log(
      `[MCP] Prompt manifest refreshed from CDN (v${VERSION}, ${Object.keys(manifest.prompts).length} prompts)`
    );
  } catch (err) {
    console.error("[MCP] CDN refresh failed:", err);
    throw err;
  }
}
