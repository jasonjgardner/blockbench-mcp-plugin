/// <reference types="blockbench-types" />
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTool, type IToolSpec } from "@/lib/factories";
import { STATUS_STABLE } from "@/lib/constants";
import { createJsonResult } from "@/lib/tool-results";

/** Mode discovery takes no arguments and evaluates the current host registry at call time. */
export const listModesParameters = z.object({});

/** Native mode ID to select; a runtime string supports modes added by other plugins. */
export const setModeParameters = z.object({
  mode_id: z.string().min(1).describe(
    "Mode ID returned by list_modes, such as 'edit', 'paint', 'animate', or 'display'. The Animate tab uses 'animate'. The current project must satisfy the mode's native condition."
  ),
});

/**
 * Mode navigation stays discoverable in every editor state, including without a
 * project, so agents can inspect their options before entering a working mode.
 * Only execution evaluates Blockbench globals; docs generation needs no host.
 */
export const modeToolDocs: IToolSpec[] = [
  {
    name: "list_modes",
    description: "Lists Blockbench editor tabs/modes with IDs, names, native availability, and the current mode. Includes plugin-added modes. Use before set_mode to discover whether Edit, Paint, Animate, or Display is available for the current project. Camera angles are controlled separately by set_camera_angle.",
    annotations: { title: "List Modes", readOnlyHint: true, openWorldHint: false },
    parameters: listModesParameters,
    status: STATUS_STABLE,
  },
  {
    name: "set_mode",
    description: "Switches Blockbench's editor tab through its native mode trigger, respecting the mode's condition. Use mode_id='animate' to enter Animate before animation work, 'paint' before native painting tools, or 'edit' to return. Returns the resulting mode and available modes; refresh tools/list for changed tool availability. Selecting the current mode does nothing. Does not change the project's format. When the user enabled the AI Scratchpad setting, mode_id='ai_scratchpad' relaxes the format's cube size, rotation and integer-size guardrails until another mode is selected.",
    annotations: { title: "Set Mode", destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: setModeParameters,
    status: STATUS_STABLE,
  },
];

interface IModeSummary {
  id: string;
  name: string;
  available: boolean;
  selected: boolean;
}

interface IModeSnapshot {
  current_mode: string | null;
  modes: IModeSummary[];
}

function currentModeId(): string | null {
  const selected = Modes.selected;
  if (!selected || typeof selected !== "object") return null;
  return selected.id;
}

function isModeAvailable(mode: Mode): boolean {
  try {
    return Condition(mode.condition);
  } catch {
    // Some native conditions access Format without a project guard. One broken
    // or temporarily unavailable plugin mode must not prevent discovery of others.
    return false;
  }
}

function inspectModes(): IModeSnapshot {
  const current_mode = currentModeId();
  return {
    current_mode,
    modes: Object.values(Modes.options)
      .map(mode => ({ id: mode.id, name: mode.name, available: isModeAvailable(mode), selected: mode.id === current_mode }))
      .toSorted((a, b) => a.id.localeCompare(b.id)),
  };
}

function modeResult(snapshot: IModeSnapshot, change?: { previous_mode: string | null; changed: boolean }): CallToolResult {
  return createJsonResult({ ...snapshot, ...change });
}

/**
 * Register native mode discovery and switching independently of the active mode.
 * Switching uses the host's trigger instead of changing flags directly, preserving
 * animation, paint, panel, and selection hooks. The shared factory refreshes tool
 * availability after execution and notifies every connected client when it changes.
 */
export function registerModeTools(): void {
  createTool(modeToolDocs[0].name, {
    ...modeToolDocs[0],
    async execute(): Promise<CallToolResult> {
      return modeResult(inspectModes());
    },
  }, modeToolDocs[0].status);

  createTool(modeToolDocs[1].name, {
    ...modeToolDocs[1],
    async execute({ mode_id }): Promise<CallToolResult> {
      if (!Object.hasOwn(Modes.options, mode_id)) {
        throw new Error(`Mode "${mode_id}" was not found. Use list_modes to discover registered mode IDs.`);
      }
      const mode = Modes.options[mode_id];
      if (!isModeAvailable(mode)) {
        throw new Error(`Mode "${mode_id}" is unavailable in the current project or editor state. Use list_modes to find an available mode; some project formats do not support Animate or Display.`);
      }
      const previous_mode = currentModeId();
      if (previous_mode === mode.id) return modeResult(inspectModes(), { previous_mode, changed: false });

      // Mode.trigger() rechecks Condition and runs the host's normal select hooks.
      // Its void return value also represents refusal, so verify the resulting mode.
      mode.trigger();
      if (currentModeId() !== mode.id) {
        throw new Error(`Blockbench did not enter mode "${mode_id}". Use list_modes to inspect the current state before retrying.`);
      }
      return modeResult(inspectModes(), { previous_mode, changed: true });
    },
  }, modeToolDocs[1].status);
}
