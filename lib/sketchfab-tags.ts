/// <reference types="blockbench-types" />
import type { IAiDisclosureFields } from "@/lib/ai-disclosure";

interface ISketchfabDialog {
  id: string;
  form_config?: unknown;
  form?: unknown;
}

const CREATED_WITH_AI_TAG = "CreatedWithAI";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function updateSuggestions(dialog: ISketchfabDialog): void {
  if (dialog.id !== "sketchfab_uploader" || typeof Project === "undefined" || !Project || (Project as unknown as IAiDisclosureFields).ai_used !== true) return;
 
  // Older Blockbench versions keep the form configuration directly in `form`.
  const form = dialog.form_config ?? dialog.form;
  if (!isRecord(form) || !isRecord(form.tag_suggestions)) return;
  
  const buttons: unknown = form.tag_suggestions.buttons;
 
  if (!Array.isArray(buttons) || !buttons.every((tag: unknown) => typeof tag === "string")) return;

  const suggestions = [...new Set((buttons as string[]).map(tag =>
    tag.toLowerCase() === "noai" ? CREATED_WITH_AI_TAG : tag
  ))];

  if (!suggestions.includes(CREATED_WITH_AI_TAG)) {
    suggestions.push(CREATED_WITH_AI_TAG);
  }
  
  // Preserve the array captured by Blockbench's tag button click handler.
  buttons.splice(0, buttons.length, ...suggestions);
}

let hostPrototype: typeof Dialog.prototype | undefined;
let originalBuild: typeof Dialog.prototype.build | undefined;
let patchedBuild: typeof Dialog.prototype.build | undefined;

/**
 * Adjusts Sketchfab suggestions before the host builds its buttons. Projects
 * marked `ai_used: true` suggest CreatedWithAI; other dialogs and projects pass
 * through unchanged. Installation is idempotent and supports legacy form storage.
 */
export function setupSketchfabTags(): void {
  if (originalBuild || typeof Dialog === "undefined") return;
  hostPrototype = Dialog.prototype;
  const build = hostPrototype.build;
  originalBuild = build;
  patchedBuild = function (this: Dialog): Dialog {
    updateSuggestions(this);
    return build.call(this);
  };
  hostPrototype.build = patchedBuild;
}

/** Restores the host dialog builder on unload without replacing a later plugin's hook. */
export function teardownSketchfabTags(): void {
  if (hostPrototype && originalBuild && hostPrototype.build === patchedBuild) {
    hostPrototype.build = originalBuild;
  }
  hostPrototype = undefined;
  originalBuild = undefined;
  patchedBuild = undefined;
}
