/**
 * Private stand-in for `lib/factories.ts` inside tool fixture bundles.
 *
 * `loadToolDefinitions()` substitutes this file's source for the real factories
 * module, so bundled tool modules register into a bundle-local `definitions` Map
 * instead of the process-wide MCP registry and server. It mirrors the real
 * `createTool` duplicate-name check so fixtures still catch double registration.
 *
 * Never import this file from a test: it only makes sense inside a bundle.
 *
 * @module
 */

/** Tool metadata mirrored from the real `tools` registry, for modules that read it (e.g. capabilities). */
export interface ICapturedToolMeta {
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly status: string;
}

/** The portion of a `createTool` configuration that the capture registry relies on. */
export interface ICapturedToolInput {
  readonly description: string;
  readonly annotations?: { readonly title?: string };
  readonly parameters: unknown;
  readonly execute: unknown;
}

/** A captured tool: the original configuration plus its registration metadata. */
export interface ICapturedTool extends ICapturedToolInput {
  readonly name: string;
  readonly status: string;
  readonly enabled: boolean;
}

/** Captured tool configurations keyed by tool name; re-exported by the fixture entry. */
export const definitions = new Map<string, ICapturedTool>();

/** Bundle-local mirror of the real `tools` metadata registry. */
export const tools: Record<string, ICapturedToolMeta> = {};

/**
 * Captures a tool configuration instead of registering it with an MCP server.
 *
 * @param name - Tool name.
 * @param tool - The configuration the tool module passed, including `parameters` and `execute`.
 * @param status - Tool status; defaults to `"stable"` like the real factory.
 * @param enabled - Whether the tool is enabled; defaults to `true` like the real factory.
 * @returns The mirrored metadata entry.
 * @throws {Error} When a tool with the same name was already captured in this bundle.
 */
export function createTool(name: string, tool: ICapturedToolInput, status = "stable", enabled = true): ICapturedToolMeta {
  if (definitions.has(name)) throw new Error(`Tool with name "${name}" already exists.`);
  const meta: ICapturedToolMeta = { description: tool.annotations?.title ?? tool.description, enabled, name, status };
  definitions.set(name, { ...tool, enabled, name, status });
  tools[name] = meta;
  return meta;
}
