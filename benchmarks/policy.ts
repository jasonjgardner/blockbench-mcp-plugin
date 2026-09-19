import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool-call rules shared by the harness's own agent loop and the MCP proxy that
 * CLI agents connect through, so every track enforces the same policy.
 */

const cameraTools = new Set(["capture_screenshot", "set_camera_angle"]);
const inlineImage = /^data:image\/[\w.+-]+;base64,/;

/** Rejects arguments that could escape the assigned project, filesystem sandbox or evidence view. */
export function assertSafeCall(
  name: string,
  args: Record<string, unknown>,
  view: string,
): void {
  if ("path" in args || "file_path" in args || "project" in args) {
    throw new Error("Filesystem paths and project overrides are unavailable.");
  }
  if (
    name === "create_texture" &&
    typeof args.data === "string" &&
    !inlineImage.test(args.data)
  ) {
    throw new Error(
      "Texture data must be inline image bytes, not a filesystem path or URL.",
    );
  }
  if (cameraTools.has(name) && args.view !== view) {
    throw new Error(`Use the assigned offscreen view: ${view}`);
  }
}

/** A tool result carrying only a text message, optionally flagged as an error. */
export function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

/**
 * Converts an archived tool result into text-only content: binary items become a
 * note naming the archived artifact (this is a text-observation track), and long
 * text is clipped to `limit` characters with an explicit marker.
 */
export function textOnlyResult(
  archived: unknown,
  limit: number,
): CallToolResult {
  const record =
    typeof archived === "object" && archived !== null
      ? (archived as Record<string, unknown>)
      : {};
  const items = Array.isArray(record.content) ? record.content : [];
  const texts = items.map((item: unknown) => {
    const entry =
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)
        : {};
    if (entry.type === "text" && typeof entry.text === "string")
      return entry.text;
    if (typeof entry.artifact === "string") {
      return `[${String(entry.type)} archived as ${entry.artifact}; not visible in this text-only track]`;
    }
    return JSON.stringify(entry);
  });
  const joined = texts.join("\n");
  const text =
    joined.length <= limit
      ? joined
      : `${joined.slice(0, limit)}\n[TRUNCATED; full response is archived. Use targeted or paginated queries.]`;
  return textResult(text, record.isError === true);
}
