import { getAllResourceDefinitions, notifyResourceListChanged, refreshToolAvailability } from "@/lib/factories";

const EDITOR_EVENTS = [
  "select_project", "unselect_project", "close_project", "new_project", "load_project",
  "select_format", "convert_format", "select_mode", "unselect_mode", "update_selection",
  "finish_edit", "undo", "redo", "finish_selection_change", "finished_selection_change",
  "update_texture_selection", "add_texture", "remove_texture",
  "installed_plugin", "loaded_plugin", "uninstalled_plugin", "unloaded_plugin",
] as const;

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let queued = false;
let generation = 0;
let resourceFingerprint: string | undefined;
let readingResources = false;

// The host emits several plugin/project events omitted by blockbench-types 5.0.
interface IEditorEvents {
  on(event: string, callback: () => void): unknown;
  removeListener(event: string, callback: () => void): unknown;
}

async function refreshResourceAvailability(): Promise<void> {
  if (readingResources) return;
  const currentGeneration = generation;
  readingResources = true;
  try {
    // Compare metadata only: listing must never compile files or read texture bytes.
    const lists = await Promise.all(Object.values(getAllResourceDefinitions()).map(async definition => {
      if (!definition.listCallback) return [];
      return (await definition.listCallback()).resources;
    }));
    if (currentGeneration !== generation) return;
    const fingerprint = JSON.stringify(lists.flat().toSorted((a, b) => a.uri.localeCompare(b.uri)));
    if (fingerprint === resourceFingerprint) return;
    const changed = resourceFingerprint !== undefined;
    resourceFingerprint = fingerprint;
    if (changed) notifyResourceListChanged();
  } catch {
    // A transient editor teardown must not break native event dispatch. Keep the
    // last successful list so recovery can still notify clients of the change.
  } finally {
    readingResources = false;
  }
}

function scheduleRefresh(): void {
  if (queued) return;
  queued = true;
  const currentGeneration = generation;
  queueMicrotask(() => {
    queued = false;
    if (currentGeneration !== generation) return;
    refreshToolAvailability();
    void refreshResourceAvailability();
  });
}

/**
 * Track editor changes after native event handlers finish updating globals.
 * A one-second fallback also covers condition dependencies without Blockbench
 * events (plugin installation, dialog state, and direct property edits).
 */
export function setupEditorStateSync(): void {
  if (refreshTimer !== undefined) return;
  const events = Blockbench as unknown as IEditorEvents;
  EDITOR_EVENTS.forEach(event => events.on(event, scheduleRefresh));
  refreshTimer = setInterval(scheduleRefresh, 1000);
  scheduleRefresh();
}

/** Remove listeners and polling, invalidating queued work before the plugin unloads. */
export function teardownEditorStateSync(): void {
  if (refreshTimer !== undefined) {
    clearInterval(refreshTimer);
    const events = Blockbench as unknown as IEditorEvents;
    EDITOR_EVENTS.forEach(event => events.removeListener(event, scheduleRefresh));
  }
  refreshTimer = undefined;
  resourceFingerprint = undefined;
  queued = false;
  generation++;
}
