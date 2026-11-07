/// <reference types="blockbench-types" />
/// <reference types="webmcp-types" />

import { trackToolWrites } from "@/lib/ai-disclosure";
import type { ToolCondition } from "@/server/tool-conditions";

/** Maximum length for WebMCP tool and parameter names. */
export const WEBMCP_MAX_NAME_LENGTH = 30;

/** Maximum length for a WebMCP tool description. */
export const WEBMCP_MAX_TOOL_DESCRIPTION_LENGTH = 500;

/** Maximum length for a WebMCP parameter description. */
export const WEBMCP_MAX_PARAM_DESCRIPTION_LENGTH = 150;

/** Maximum character budget (~400 tokens) for a WebMCP tool output payload. */
export const WEBMCP_MAX_OUTPUT_CHARS = 1500;

/**
 * Default page size for paginated WebMCP list tools.
 *
 * Ten outliner rows (UUID, name, type, parent, selection flag) plus the pagination
 * envelope fit inside {@link WEBMCP_MAX_OUTPUT_CHARS}, so the budget clamp rarely has
 * to shrink a page and pagination stays gap-free.
 */
export const WEBMCP_DEFAULT_PAGE_SIZE = 10;

/** Largest page size a caller may request from a paginated WebMCP tool. */
export const WEBMCP_MAX_PAGE_SIZE = 25;

/** Character ceiling for the `error` text of a structured error payload. */
const WEBMCP_MAX_ERROR_MESSAGE_CHARS = 600;

/** Agent attribution label recorded on `.bbmodel` AI disclosure metadata when WebMCP tools mutate a project. */
export const WEBMCP_AGENT_NAME = "WebMCP Browser Agent";

/** Forbidden implementation jargon terms that must never appear in WebMCP descriptions. */
const FORBIDDEN_JARGON_TERMS = [
  "redux",
  "pinia",
  "express",
  "postgres",
  "graphql",
  "grpc",
  "react query",
  "mutation handler",
  "rest controller",
] as const;

/**
 * Structured error payload resolved by native imperative WebMCP tools.
 *
 * Per the W3C WebMCP specification, an unhandled promise rejection in `execute()`
 * surfaces to the agent as a generic `DOMException: UnknownError`. Resolving this
 * structured shape preserves the actionable message, error code, and remediation hint.
 */
export interface IWebMcpErrorPayload {
  /** Human- and LLM-readable explanation of what failed. */
  error: string;
  /** Machine-readable error category (e.g. `NO_ACTIVE_PROJECT`, `PREREQUISITE_MODE`). */
  code: string;
  /** Whether the agent can recover by adjusting arguments or running a prerequisite tool. */
  retryable: boolean;
  /** Concrete next step the agent should take or ask the user. */
  suggestion?: string;
}

/**
 * Standard paginated response envelope enforcing the 1,500-character output budget.
 */
export interface IWebMcpPaginatedResult<T> {
  /** Current 1-based page number. */
  page: number;
  /** Maximum items per page. */
  page_size: number;
  /** Total matching items across all pages. */
  total_count: number;
  /** Total available pages. */
  total_pages: number;
  /** Slice of items for the requested page. */
  results: T[];
  /** Optional facet counts summarizing the full collection. */
  available_facets?: Record<string, unknown>;
}

/**
 * JSON Schema property descriptor used in WebMCP `inputSchema` definitions.
 */
export interface IWebMcpSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: IWebMcpSchemaProperty | { type: string; enum?: readonly string[]; properties?: Record<string, IWebMcpSchemaProperty>; required?: readonly string[] };
  properties?: Record<string, IWebMcpSchemaProperty>;
  required?: readonly string[];
}

/**
 * JSON Schema root object for a WebMCP tool's `inputSchema`.
 */
export interface IWebMcpInputSchema {
  type: "object";
  properties: Record<string, IWebMcpSchemaProperty>;
  required?: readonly string[];
}

/**
 * Declarative + executable WebMCP tool definition managed by the Blockbench web plugin.
 */
export interface IWebMcpToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
  /** Tool identifier (<= 30 characters, action verb). */
  name: string;
  /** Optional human-readable title. */
  title?: string;
  /** "What + When" description (<= 500 characters, no repeated parameter names or jargon). */
  description: string;
  /** JSON Schema for input parameters. */
  inputSchema: IWebMcpInputSchema;
  /** Strictly opt-in annotations (only keys with value `true`). */
  annotations?: WebMCP.ToolAnnotations;
  /** Optional Blockbench condition gating when the tool is registered/available. */
  condition?: ToolCondition;
  /** Tool execution handler; returns a serializable object/string or throws a {@link WebMcpActionableError} (any other throw becomes `EXECUTION_FAILED`). */
  execute: (args: TInput, options: WebMCP.ToolExecuteCallbackOptions) => Promise<unknown> | unknown;
}

/**
 * Audit finding returned by {@link validateToolAgainstWebMcpChecklist}.
 */
export interface IWebMcpAuditFinding {
  /** Affected tool name. */
  toolName: string;
  /** Checklist category (`budgets`, `descriptions`, `annotations`, `schema`). */
  category: "budgets" | "descriptions" | "annotations" | "schema";
  /** Description of the violation and concrete fix. */
  message: string;
}

/**
 * Options for registering a suite of WebMCP tools on `document.modelContext`.
 */
export interface IWebMcpRegistrationOptions {
  /** Document instance to register on; defaults to global `document`. */
  targetDocument?: Document;
  /** Optional trusted origins allowed to invoke the registered tools across iframes. */
  exposedTo?: string[];
}

/**
 * Active registration handle returned by {@link registerWebMcpToolset}.
 */
export interface IWebMcpRegistrationHandle {
  /** Re-evaluates tool conditions and registers/unregisters tools on `document.modelContext`. */
  refreshAvailability: () => Promise<void>;
  /** Aborts all active tool registrations and detaches editor listeners. */
  dispose: () => void;
  /** Returns the names of currently registered tools. */
  getRegisteredToolNames: () => readonly string[];
  /** Returns the last `registerTool` rejection message per tool name; empty when every registration succeeded. */
  getRegistrationFailures: () => ReadonlyMap<string, string>;
}

/** Shape of a Zod validation error, matched structurally so the runtime never depends on the Zod package. */
interface IZodLikeError {
  name: string;
  issues: ReadonlyArray<{ path?: ReadonlyArray<string | number>; message: string }>;
}

/** Narrows an unknown thrown value to a Zod-style validation error carrying `issues`. */
function isZodLikeError(error: unknown): error is IZodLikeError {
  if (!(error instanceof Error) || error.name !== "ZodError") return false;
  return Array.isArray((error as { issues?: unknown }).issues);
}

/**
 * Custom error class carrying a structured WebMCP error code, retryability flag, and remediation hint.
 */
export class WebMcpActionableError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly suggestion?: string;

  public constructor(
    message: string,
    code: string = "EXECUTION_FAILED",
    retryable: boolean = true,
    suggestion?: string,
  ) {
    super(message);
    this.name = "WebMcpActionableError";
    this.code = code;
    this.retryable = retryable;
    if (suggestion !== undefined) {
      this.suggestion = suggestion;
    }
  }
}

/**
 * Checks whether the current browser environment exposes the W3C WebMCP imperative API
 * on `document.modelContext.registerTool`.
 *
 * @param targetDocument - Optional document override for testing.
 * @returns `true` when `document.modelContext.registerTool` is available.
 */
export function hasWebMcpSupport(targetDocument?: Document): boolean {
  const doc = targetDocument ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc || !("modelContext" in doc) || !doc.modelContext) return false;
  return typeof doc.modelContext.registerTool === "function";
}

/**
 * Normalizes tool annotations so only strictly opt-in `true` flags are emitted.
 *
 * WebMCP annotations default to `false` and must never declare `: false` or combine
 * `readOnlyHint: true` with `consequentialHint: true`. Returns `undefined` when no
 * annotation hint is `true` so routine mutating tools omit `annotations` entirely.
 *
 * @param raw - Input annotations object.
 * @returns Sanitized opt-in annotations or `undefined`.
 */
export function sanitizeWebMcpAnnotations(
  raw?: Partial<WebMCP.ToolAnnotations>,
): WebMCP.ToolAnnotations | undefined {
  if (!raw) return undefined;
  const sanitized: WebMCP.ToolAnnotations = {};
  if (raw.readOnlyHint === true && raw.consequentialHint !== true) {
    sanitized.readOnlyHint = true;
  }
  if (raw.consequentialHint === true) {
    sanitized.consequentialHint = true;
  }
  if (raw.untrustedContentHint === true) {
    sanitized.untrustedContentHint = true;
  }
  if (raw.debugging === true) {
    sanitized.debugging = true;
  }
  if (Object.keys(sanitized).length === 0) return undefined;
  return sanitized;
}

/**
 * Paginates an array of items into the standard WebMCP pagination envelope.
 *
 * @param items - Full filtered list of items.
 * @param page - Requested 1-based page number (defaults to 1).
 * @param pageSize - Requested page size (defaults to 12, clamped to 1..25).
 * @param availableFacets - Optional facet summary counts.
 * @returns Paginated result envelope.
 */
export function paginateWebMcpItems<T>(
  items: readonly T[],
  page: number = 1,
  pageSize: number = WEBMCP_DEFAULT_PAGE_SIZE,
  availableFacets?: Record<string, unknown>,
): IWebMcpPaginatedResult<T> {
  const safePageSize = Math.min(WEBMCP_MAX_PAGE_SIZE, Math.max(1, Math.trunc(pageSize || WEBMCP_DEFAULT_PAGE_SIZE)));
  const totalCount = items.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));
  const safePage = Math.min(totalPages, Math.max(1, Math.trunc(page || 1)));
  const startOffset = (safePage - 1) * safePageSize;
  const results = items.slice(startOffset, startOffset + safePageSize);
  return {
    page: safePage,
    page_size: safePageSize,
    total_count: totalCount,
    total_pages: totalPages,
    results,
    ...(availableFacets ? { available_facets: availableFacets } : {}),
  };
}

/**
 * Enforces the 1,500-character (~400 token) WebMCP output budget on any tool return value.
 *
 * When a payload exceeds `maxChars`, returns a structured continuation envelope with
 * `truncated: true`, `total_length`, `next_offset`, and an exact slice so the agent can
 * page forward without silent data loss.
 *
 * @param payload - Raw return value from a tool handler.
 * @param maxChars - Character ceiling (defaults to {@link WEBMCP_MAX_OUTPUT_CHARS}).
 * @returns Bounded payload guaranteed to serialize within `maxChars`.
 */
export function clampWebMcpPayload(
  payload: unknown,
  maxChars: number = WEBMCP_MAX_OUTPUT_CHARS,
): unknown {
  if (typeof payload === "string") {
    if (payload.length <= maxChars) return payload;
    return buildTextContinuation(payload, maxChars, `Output exceeded ${maxChars} chars; this is the first slice.`);
  }

  const serialized = JSON.stringify(payload);
  if (!serialized || serialized.length <= maxChars) return payload;

  const shrunk = shrinkPaginatedResults(payload, maxChars);
  if (shrunk !== undefined) return shrunk;

  return buildTextContinuation(
    serialized,
    maxChars,
    `Serialized payload exceeded ${maxChars} chars; this is a raw JSON prefix. Narrow filters or request a smaller page_size.`,
  );
}

/**
 * Builds the `{ truncated, content, next_offset }` envelope for oversized text, shrinking the
 * slice until the serialized envelope (including JSON escaping) fits inside `maxChars`.
 */
function buildTextContinuation(text: string, maxChars: number, hint: string): Record<string, unknown> {
  const envelope = (sliceLength: number): Record<string, unknown> => ({
    truncated: true,
    total_length: text.length,
    offset: 0,
    next_offset: sliceLength,
    content: text.slice(0, sliceLength),
    continuation_hint: hint,
  });
  const fits = (sliceLength: number): boolean => JSON.stringify(envelope(sliceLength)).length <= maxChars;
  const initial = Math.max(1, maxChars - hint.length - 120);
  const sliceLength = shrinkUntil(initial, fits);
  return envelope(sliceLength);
}

/**
 * Drops trailing `results` entries from a pagination envelope until it fits, and tells the agent
 * which `page_size` re-pages the collection without skipping items. Returns `undefined` when the
 * payload is not a pagination envelope or even a single result cannot fit.
 */
function shrinkPaginatedResults(payload: unknown, maxChars: number): Record<string, unknown> | undefined {
  if (typeof payload !== "object" || payload === null || !("results" in payload)) return undefined;
  const record = payload as Record<string, unknown> & { results: unknown };
  const results: readonly unknown[] | undefined = Array.isArray(record.results) ? record.results : undefined;
  if (!results || results.length < 2) return undefined;

  const requested = typeof record.page_size === "number" ? record.page_size : results.length;
  const candidate = (count: number): Record<string, unknown> => ({
    ...record,
    results: results.slice(0, count),
    page_size: count,
    truncated: true,
    continuation_hint: `Only ${count} of ${requested} requested items fit the output budget. Re-run from page 1 with page_size=${count} to page without gaps.`,
  });
  const fits = (count: number): boolean => JSON.stringify(candidate(count)).length <= maxChars;
  const count = shrinkUntil(results.length - 1, fits);
  return fits(count) ? candidate(count) : undefined;
}

/**
 * Halves `value` until `fits(value)` holds, then grows back linearly to the largest fitting value.
 * Returns `1` when even the smallest candidate does not fit.
 */
function shrinkUntil(value: number, fits: (candidate: number) => boolean): number {
  const coarse = (current: number): number => (current <= 1 || fits(current) ? current : coarse(Math.floor(current / 2)));
  const floor = coarse(value);
  if (!fits(floor)) return 1;
  const refine = (low: number, high: number): number => {
    if (high - low <= 1) return low;
    const mid = Math.floor((low + high) / 2);
    return fits(mid) ? refine(mid, high) : refine(low, mid);
  };
  return refine(floor, Math.min(value, floor * 2) + 1);
}

/**
 * Synchronizes Blockbench's viewport canvas and Vue UI state before returning to the agent.
 *
 * `Canvas.updateAll()` refreshes the three.js scene; Vue panels (outliner, texture list,
 * timeline) re-render on `Vue.nextTick`, so that is awaited when the global is present.
 */
export async function syncBlockbenchUi(): Promise<void> {
  if (typeof Canvas !== "undefined" && Canvas && typeof Canvas.updateAll === "function") {
    try {
      Canvas.updateAll();
    } catch {
      // Headless test mocks may only stub partial Canvas methods.
    }
  }
  const vue = (globalThis as { Vue?: { nextTick?: () => Promise<void> } }).Vue;
  if (typeof vue?.nextTick === "function") {
    await vue.nextTick();
    return;
  }
  await new Promise<void>(resolve => queueMicrotask(resolve));
}

/** Shortens an error message so the structured error payload itself stays well inside the output budget. */
function clampErrorMessage(message: string): string {
  if (message.length <= WEBMCP_MAX_ERROR_MESSAGE_CHARS) return message;
  return `${message.slice(0, WEBMCP_MAX_ERROR_MESSAGE_CHARS - 1).trimEnd()}…`;
}

/** Renders the first few Zod issues as `path: message` lines for the agent. */
function formatZodIssues(error: IZodLikeError): string {
  return error.issues
    .slice(0, 5)
    .map(issue => {
      const path = (issue.path ?? []).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Converts any thrown error into a structured {@link IWebMcpErrorPayload} so `registerTool`
 * resolves actionable guidance rather than rejecting with `DOMException: UnknownError`.
 *
 * @param error - Thrown error or rejection value.
 * @returns Structured error object with `error`, `code`, `retryable`, and optional `suggestion`.
 */
export function toWebMcpErrorPayload(error: unknown): IWebMcpErrorPayload {
  if (error instanceof WebMcpActionableError) {
    return {
      error: clampErrorMessage(error.message),
      code: error.code,
      retryable: error.retryable,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
    };
  }
  if (isZodLikeError(error)) {
    return {
      error: clampErrorMessage(`Invalid arguments: ${formatZodIssues(error)}`),
      code: "INVALID_ARGUMENTS",
      retryable: true,
      suggestion: "Correct the listed parameters to match the tool's input schema and call the tool again.",
    };
  }
  const message = clampErrorMessage(error instanceof Error ? error.message : String(error));
  if (/no project|open a project/i.test(message)) {
    return {
      error: message,
      code: "NO_ACTIVE_PROJECT",
      retryable: true,
      suggestion: "Call create_project first or ask the user to open a .bbmodel file.",
    };
  }
  if (/not found/i.test(message)) {
    return {
      error: message,
      code: "NOT_FOUND",
      retryable: true,
      suggestion: "Call list_outliner_items or list_textures first to inspect valid names and UUIDs.",
    };
  }
  return {
    error: message,
    code: "EXECUTION_FAILED",
    retryable: false,
  };
}

/**
 * Evaluates a Blockbench tool condition safely without throwing when globals are absent.
 *
 * @param condition - Condition spec attached to a tool.
 * @returns `true` when the tool is currently available.
 */
export function evaluateWebMcpCondition(condition?: ToolCondition): boolean {
  if (condition === undefined || condition === true) return true;
  if (condition === false) return false;
  if (typeof Condition === "function") {
    try {
      return Boolean(Condition(condition as ConditionResolvable));
    } catch {
      return false;
    }
  }
  if (typeof condition === "function") {
    try {
      return Boolean(condition());
    } catch {
      return false;
    }
  }
  if (typeof condition === "object" && condition !== null && condition.project === true) {
    return typeof Project !== "undefined" && Boolean(Project);
  }
  return true;
}

/**
 * Wraps a tool's `execute` handler with WebMCP cancellation checks, AI usage disclosure
 * tracking, UI synchronization, output budget clamping, and structured error resolution.
 *
 * @param tool - WebMCP tool definition.
 * @returns Safe callback compatible with `document.modelContext.registerTool`.
 */
export function createSafeWebMcpExecutor<TInput extends Record<string, unknown>>(
  tool: IWebMcpToolDefinition<TInput>,
): WebMCP.ToolExecuteCallback<TInput> {
  return async (inputObject: TInput, options: WebMCP.ToolExecuteCallbackOptions): Promise<unknown> => {
    if (options?.signal?.aborted) {
      return {
        error: `Execution of "${tool.name}" was cancelled before starting.`,
        code: "EXECUTION_ABORTED",
        retryable: true,
      } satisfies IWebMcpErrorPayload;
    }

    if (!evaluateWebMcpCondition(tool.condition)) {
      return {
        error: `Tool "${tool.name}" is unavailable in the current editor state.`,
        code: "PREREQUISITE_STATE",
        retryable: true,
        suggestion: "Check get_project_summary or create_project before calling this tool.",
      } satisfies IWebMcpErrorPayload;
    }

    try {
      const isReadOnly = tool.annotations?.readOnlyHint === true;
      const run = async (): Promise<unknown> => await tool.execute(inputObject, options);
      const rawOutput = isReadOnly
        ? await run()
        : await trackToolWrites(WEBMCP_AGENT_NAME, run);

      if (!isReadOnly) {
        await syncBlockbenchUi();
      }
      return clampWebMcpPayload(rawOutput);
    } catch (error: unknown) {
      return clampWebMcpPayload(toWebMcpErrorPayload(error));
    }
  };
}

/** Walks nested `properties`/`items` so array-of-object parameters are audited like top-level ones. */
function collectSchemaProperties(
  properties: Record<string, IWebMcpSchemaProperty> | undefined,
  prefix: string,
): Array<[string, IWebMcpSchemaProperty]> {
  return Object.entries(properties ?? {}).flatMap(([name, spec]): Array<[string, IWebMcpSchemaProperty]> => {
    const path = prefix ? `${prefix}.${name}` : name;
    const items = spec.items && "properties" in spec.items ? spec.items.properties : undefined;
    return [
      [path, spec],
      ...collectSchemaProperties(spec.properties, path),
      ...collectSchemaProperties(items as Record<string, IWebMcpSchemaProperty> | undefined, `${path}[]`),
    ];
  });
}

/**
 * Audits a tool definition against the WebMCP Tool Checklist (`references/audit-checklist.md`).
 *
 * Checks character budgets, "What + When" phrasing, absence of repeated `inputSchema`
 * property names in the tool description, absence of implementation jargon, and opt-in
 * annotation rules.
 *
 * @param tool - Tool definition to validate.
 * @returns Array of audit findings (empty when the tool is fully compliant).
 */
export function validateToolAgainstWebMcpChecklist(
  tool: IWebMcpToolDefinition,
): IWebMcpAuditFinding[] {
  const findings: IWebMcpAuditFinding[] = [];

  if (tool.name.length === 0 || tool.name.length > WEBMCP_MAX_NAME_LENGTH) {
    findings.push({
      toolName: tool.name,
      category: "budgets",
      message: `Tool name "${tool.name}" (${tool.name.length} chars) exceeds ${WEBMCP_MAX_NAME_LENGTH} chars.`,
    });
  }

  if (tool.description.length === 0 || tool.description.length > WEBMCP_MAX_TOOL_DESCRIPTION_LENGTH) {
    findings.push({
      toolName: tool.name,
      category: "budgets",
      message: `Tool description (${tool.description.length} chars) exceeds ${WEBMCP_MAX_TOOL_DESCRIPTION_LENGTH} chars.`,
    });
  }

  if (!/\bUse when\b/i.test(tool.description)) {
    findings.push({
      toolName: tool.name,
      category: "descriptions",
      message: `Tool description must follow the "What + When" formula (include "Use when ...").`,
    });
  }

  const lowerDesc = tool.description.toLowerCase();
  FORBIDDEN_JARGON_TERMS.forEach(term => {
    if (lowerDesc.includes(term)) {
      findings.push({
        toolName: tool.name,
        category: "descriptions",
        message: `Tool description contains forbidden implementation jargon "${term}".`,
      });
    }
  });

  const topLevelNames = Object.keys(tool.inputSchema?.properties ?? {});
  topLevelNames.forEach(propName => {
    if (propName.includes("_") && lowerDesc.includes(propName.toLowerCase())) {
      findings.push({
        toolName: tool.name,
        category: "descriptions",
        message: `Tool description repeats inputSchema parameter name "${propName}".`,
      });
    }
  });

  collectSchemaProperties(tool.inputSchema?.properties, "").forEach(([propPath, propSpec]) => {
    const leafName = propPath.split(/\.|\[\]\./).at(-1) ?? propPath;
    if (leafName.length > WEBMCP_MAX_NAME_LENGTH) {
      findings.push({
        toolName: tool.name,
        category: "budgets",
        message: `Parameter "${propPath}" (${leafName.length} chars) exceeds ${WEBMCP_MAX_NAME_LENGTH} chars.`,
      });
    }
    if ((propSpec.description?.length ?? 0) > WEBMCP_MAX_PARAM_DESCRIPTION_LENGTH) {
      findings.push({
        toolName: tool.name,
        category: "budgets",
        message: `Parameter "${propPath}" description (${propSpec.description.length} chars) exceeds ${WEBMCP_MAX_PARAM_DESCRIPTION_LENGTH} chars.`,
      });
    }
    if (!propSpec.description || propSpec.description.trim().length === 0) {
      findings.push({
        toolName: tool.name,
        category: "schema",
        message: `Parameter "${propPath}" has no description; agents need one to fill it correctly.`,
      });
    }
  });

  if (tool.annotations) {
    const rawEntries = Object.entries(tool.annotations);
    rawEntries.forEach(([key, value]) => {
      if (value === false) {
        findings.push({
          toolName: tool.name,
          category: "annotations",
          message: `Annotation "${key}: false" declared; annotations are strictly opt-in and must be omitted when false.`,
        });
      }
    });
    if (tool.annotations.readOnlyHint === true && tool.annotations.consequentialHint === true) {
      findings.push({
        toolName: tool.name,
        category: "annotations",
        message: `Contradictory annotations: readOnlyHint and consequentialHint cannot both be true.`,
      });
    }
  }

  return findings;
}

/**
 * Registers a set of WebMCP tools on `document.modelContext` using `AbortController` signals
 * and keeps condition-gated tools synchronized with Blockbench editor state changes.
 *
 * @param definitions - Array of WebMCP tool definitions to manage.
 * @param options - Optional target document and `exposedTo` origins.
 * @returns Handle to refresh or dispose all tool registrations.
 */
export async function registerWebMcpToolset(
  definitions: readonly IWebMcpToolDefinition[],
  options: IWebMcpRegistrationOptions = {},
): Promise<IWebMcpRegistrationHandle> {
  const doc = options.targetDocument ?? (typeof document !== "undefined" ? document : undefined);
  const controllers = new Map<string, AbortController>();
  const failures = new Map<string, string>();
  let disposed = false;
  let pendingSync: Promise<void> = Promise.resolve();

  const registerDefinition = async (modelContext: WebMCP.ModelContext, def: IWebMcpToolDefinition): Promise<void> => {
    const controller = new AbortController();
    controllers.set(def.name, controller);
    const sanitizedAnnotations = sanitizeWebMcpAnnotations(def.annotations);
    const registerOptions: WebMCP.ModelContextRegisterToolOptions = {
      signal: controller.signal,
      ...(options.exposedTo ? { exposedTo: options.exposedTo } : {}),
    };
    try {
      await modelContext.registerTool(
        {
          name: def.name,
          ...(def.title ? { title: def.title } : {}),
          description: def.description,
          inputSchema: def.inputSchema,
          ...(sanitizedAnnotations ? { annotations: sanitizedAnnotations } : {}),
          execute: createSafeWebMcpExecutor(def),
        },
        registerOptions,
      );
      failures.delete(def.name);
    } catch (error: unknown) {
      // A rejected registration (invalid schema, duplicate name) must not poison the
      // whole toolset or leave a phantom controller that blocks a later retry.
      controller.abort();
      controllers.delete(def.name);
      failures.set(def.name, error instanceof Error ? error.message : String(error));
    }
  };

  const syncOnce = async (): Promise<void> => {
    if (disposed || !doc || !hasWebMcpSupport(doc) || !doc.modelContext) return;
    const modelContext = doc.modelContext;

    const tasks = definitions.map(def => {
      const available = evaluateWebMcpCondition(def.condition);
      const existing = controllers.get(def.name);
      if (!available && existing) {
        existing.abort();
        controllers.delete(def.name);
      }
      return available && !existing ? registerDefinition(modelContext, def) : Promise.resolve();
    });
    await Promise.all(tasks);
  };

  // Editor events can fire in bursts (new project + select project + select mode), so
  // refreshes are serialized to keep the abort/register bookkeeping consistent.
  const syncRegistrations = (): Promise<void> => {
    pendingSync = pendingSync.then(syncOnce, syncOnce);
    return pendingSync;
  };

  await syncRegistrations();

  return {
    refreshAvailability: syncRegistrations,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      controllers.forEach(controller => controller.abort());
      controllers.clear();
    },
    getRegisteredToolNames(): readonly string[] {
      return [...controllers.keys()];
    },
    getRegistrationFailures(): ReadonlyMap<string, string> {
      return new Map(failures);
    },
  };
}
