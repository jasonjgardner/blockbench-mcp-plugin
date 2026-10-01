/**
 * Server instructions sent to MCP clients from the `mcp_instructions` setting.
 *
 * @module
 */

/**
 * The setting's default before 1.10.0. It was never sent to clients then, so
 * stored copies are almost always the untouched default, not a user's choice.
 * Sending it now would steer every session (Hytale, PBR, Havok, ...) toward
 * low-poly Minecraft models, so it is treated as unset.
 */
export const LEGACY_DEFAULT_INSTRUCTIONS = "Generate simple, low-poly models for Minecraft inside Blockbench.";

/**
 * The instructions to send for a stored `mcp_instructions` value.
 *
 * @param stored - The raw setting value (`Settings.get("mcp_instructions")`).
 * @returns The trimmed text, or `""` when it is blank, not a string, or the legacy default.
 */
export function effectiveInstructions(stored: unknown): string {
  const text = typeof stored === "string" ? stored.trim() : "";
  return text === LEGACY_DEFAULT_INSTRUCTIONS ? "" : text;
}
