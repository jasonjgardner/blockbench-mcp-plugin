/// <reference types="blockbench-types" />
/**
 * AI usage disclosure: stamps `ai_used` and `ai_agents` onto a project the
 * first time an MCP tool writes to it.
 *
 * Writes are detected from Blockbench itself rather than from tool metadata.
 * While an MCP client's tool call is executing, an undo transaction that both
 * started (`init_edit`) and finished (`finish_edit`) outside a DOM event
 * handler, or a `new_project`, marks the active project with the calling
 * client names. Edits the user makes with the mouse or keyboard run inside DOM
 * event handlers and are never credited, even while a slow tool call is
 * awaiting. Plugin code that edits through `runUndoableEdit` records the write
 * explicitly. Read-only tools, camera moves, and mode switches never stamp.
 *
 * Both fields are native `ModelProject` properties, so they round-trip through
 * `.bbmodel` files and appear in the Project settings dialog, where the owner
 * may clear them. They are exported and shown only once `ai_used` is true, so
 * untouched files are written unchanged. Files saved by a Blockbench without
 * this plugin drop the fields, because the host exports only registered
 * properties.
 *
 * Only setup/teardown and the event handlers touch Blockbench globals.
 *
 * @module
 */
import { AI_AGENTS_PROPERTY, AI_USED_PROPERTY, SETTING_DISCLOSE_AI_USAGE } from "@/lib/constants";
import { sessionManager } from "@/lib/sessions";

/** Disclosure fields on a `ModelProject`; the host class carries no static typing for plugin properties. */
export interface IAiDisclosureFields {
  ai_used?: boolean;
  ai_agents?: string;
  saved?: boolean;
}

/** Fallback client label when the MCP session never identified itself during `initialize`. */
export const UNKNOWN_AGENT = "Unknown MCP client";

/** DOM event dispatched on `document` after a project gains or extends its AI usage stamp. */
export const AI_USAGE_CHANGED = "mcp:ai-usage-changed";

/** Client names come from the network, so they are bounded before reaching project files. */
export const MAX_AGENT_NAME_LENGTH = 64;

const AGENT_SEPARATOR = ", ";

/** Blockbench events consumed while tracking tool writes. */
const HOST_EVENTS = ["init_edit", "finish_edit", "new_project"] as const;

// blockbench-types 5.0 omits several host events, so the dispatcher is narrowed here.
interface IHostEvents {
  on(event: string, callback: () => void): unknown;
  removeListener(event: string, callback: () => void): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Whether the user enabled the disclosure toggle in Settings > General. */
export function isDisclosureEnabled(): boolean {
  if (typeof Settings === "undefined") return false;
  return Settings.get(SETTING_DISCLOSE_AI_USAGE) === true;
}

/**
 * Normalises a client-supplied name: control characters and the list
 * separator become spaces, whitespace collapses, and the length is capped.
 * Returns `undefined` when nothing printable remains.
 */
export function sanitizeAgentName(raw: string | undefined): string | undefined {
  const cleaned = raw?.replace(/[\p{C},]/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_AGENT_NAME_LENGTH).trim();
  return cleaned || undefined;
}

/** Splits a stored `ai_agents` value into trimmed, non-empty names. */
export function parseAgents(list: string | undefined): readonly string[] {
  if (!list) return [];
  return list.split(",").map(name => name.trim()).filter(name => name.length > 0);
}

/** Unions `added` into an existing `ai_agents` value, preserving first-seen order. */
export function mergeAgents(existing: string | undefined, added: Iterable<string>): string {
  const names = [...parseAgents(existing), ...[...added].flatMap(name => sanitizeAgentName(name) ?? [])];
  return [...new Set(names)].join(AGENT_SEPARATOR);
}

/**
 * Applies the disclosure fields to a project.
 *
 * The host project is shared mutable state, so this writes in place. The
 * project is marked unsaved when anything changed so the stamp reaches disk.
 *
 * @returns Whether any field changed.
 */
export function markAiUsage(project: IAiDisclosureFields, agents: Iterable<string>): boolean {
  const ai_agents = mergeAgents(project.ai_agents, agents);
  if (project.ai_used === true && ai_agents === (project.ai_agents ?? "")) return false;
  project.ai_used = true;
  project.ai_agents = ai_agents;
  project.saved = false;
  return true;
}

/** Display name of the MCP client behind a session, as sent in its `initialize` request. */
export function resolveAgentName(sessionId: string | undefined): string {
  const session = sessionId ? sessionManager.get(sessionId) : undefined;
  return sanitizeAgentName(session?.clientName) ?? UNKNOWN_AGENT;
}

/** Client names of every tool call currently executing, with a count per name for re-entrancy. */
const activeAgents = new Map<string, number>();

/** Whether the pending undo transaction began outside a DOM event handler during a tracked call. */
let pendingEditFromTool = false;

function releaseAgent(agent: string): void {
  const remaining = (activeAgents.get(agent) ?? 1) - 1;
  if (remaining <= 0) {
    activeAgents.delete(agent);
    return;
  }
  activeAgents.set(agent, remaining);
}

/**
 * Runs one tool call while attributing any project writes it causes to `agent`.
 * Concurrent calls from several clients are all credited when a write lands.
 */
export async function trackToolWrites<T>(agent: string, run: () => Promise<T>): Promise<T> {
  activeAgents.set(agent, (activeAgents.get(agent) ?? 0) + 1);
  try {
    return await run();
  } finally {
    releaseAgent(agent);
  }
}

/** Names of the clients whose tool calls are executing right now. */
export function getActiveAgents(): readonly string[] {
  return [...activeAgents.keys()];
}

/** DOM event handlers (viewport drags, shortcuts, dialogs) set `window.event` while they run. */
function isUserInteraction(): boolean {
  return typeof window !== "undefined" && window.event !== undefined;
}

function currentProject(): IAiDisclosureFields | undefined {
  if (typeof Project === "undefined" || !Project) return undefined;
  return Project as unknown as IAiDisclosureFields;
}

/**
 * Stamps the active project with every client whose tool call is executing.
 * Call after a write that plugin code made itself; a no-op outside tool calls
 * or with the toggle off.
 *
 * @returns Whether the project was stamped or updated.
 */
export function recordToolWrite(): boolean {
  if (activeAgents.size === 0 || !isDisclosureEnabled()) return false;
  const project = currentProject();
  if (!project || !markAiUsage(project, activeAgents.keys())) return false;
  if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent(AI_USAGE_CHANGED));
  return true;
}

function onInitEdit(): void {
  pendingEditFromTool = activeAgents.size > 0 && !isUserInteraction();
}

function onFinishEdit(): void {
  const fromTool = pendingEditFromTool && !isUserInteraction();
  pendingEditFromTool = false;
  if (fromTool) recordToolWrite();
}

function onNewProject(): void {
  if (!isUserInteraction()) recordToolWrite();
}

const HOST_HANDLERS: Readonly<Record<(typeof HOST_EVENTS)[number], () => void>> = {
  init_edit: onInitEdit,
  finish_edit: onFinishEdit,
  new_project: onNewProject,
};

/**
 * Native property condition: exported to `.bbmodel` and shown in the Project
 * dialog only after an agent touched the project. Blockbench passes the
 * instance as `context` when copying; the dialog passes nothing.
 */
export function disclosureCondition(context?: unknown): boolean {
  const project = isRecord(context) ? (context as IAiDisclosureFields) : currentProject();
  return project?.ai_used === true;
}

/** Loads `ai_used` from file data regardless of the condition, which would otherwise skip untouched projects. */
export function mergeAiUsed(instance: unknown, data: unknown): void {
  if (!isRecord(instance) || !isRecord(data) || typeof data[AI_USED_PROPERTY] !== "boolean") return;
  instance[AI_USED_PROPERTY] = data[AI_USED_PROPERTY];
}

/** Loads `ai_agents` from file data regardless of the condition. */
export function mergeAiAgents(instance: unknown, data: unknown): void {
  if (!isRecord(instance) || !isRecord(data) || typeof data[AI_AGENTS_PROPERTY] !== "string") return;
  instance[AI_AGENTS_PROPERTY] = data[AI_AGENTS_PROPERTY];
}

let properties: readonly { delete(): void }[] = [];
let listening = false;

/** Registers the project properties and write listeners; idempotent. */
export function setupAiDisclosure(): void {
  if (listening) return;
  properties = [
    new Property(ModelProject, "boolean", AI_USED_PROPERTY, {
      default: false,
      label: tl("mcp.project.ai_used"),
      description: tl("mcp.project.ai_used_desc"),
      condition: disclosureCondition,
      merge: mergeAiUsed,
    }),
    new Property(ModelProject, "string", AI_AGENTS_PROPERTY, {
      default: "",
      label: tl("mcp.project.ai_agents"),
      description: tl("mcp.project.ai_agents_desc"),
      condition: disclosureCondition,
      merge: mergeAiAgents,
    }),
  ];
  const events = Blockbench as unknown as IHostEvents;
  HOST_EVENTS.forEach(event => events.on(event, HOST_HANDLERS[event]));
  listening = true;
}

/** Removes listeners and property definitions; values already on projects are left untouched. */
export function teardownAiDisclosure(): void {
  if (!listening) return;
  const events = Blockbench as unknown as IHostEvents;
  HOST_EVENTS.forEach(event => events.removeListener(event, HOST_HANDLERS[event]));
  properties.forEach(property => property.delete());
  properties = [];
  activeAgents.clear();
  pendingEditFromTool = false;
  listening = false;
}
