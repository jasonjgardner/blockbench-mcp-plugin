/// <reference types="blockbench-types" />
import { VERSION } from "@/lib/constants";
import { getAllPromptDefinitions } from "@/lib/factories";
import {
  getPromptContent,
  setPromptOverride,
  clearPromptOverride,
  hasPromptOverride,
} from "@/lib/promptLoader";

/** Custom event name dispatched when prompt overrides change. */
export const PROMPT_OVERRIDE_CHANGED = "mcp:prompt-override-changed";

let overrideDialog: Dialog | null = null;

/**
 * Cleans up the override dialog reference. Call from uiTeardown().
 */
export function overrideDialogTeardown(): void {
  overrideDialog?.hide();
  overrideDialog = null;
}

/**
 * Opens a dialog for editing or resetting a prompt override.
 */
export function openPromptOverrideDialog(promptName: string): void {
  const promptDefs = getAllPromptDefinitions();
  const promptDef = promptDefs[promptName];

  if (!promptDef) {
    Blockbench.showQuickMessage(
      tl("mcp.dialog.prompt_not_found", [promptName]),
      2000
    );
    return;
  }

  overrideDialog?.hide();

  const isOverridden = hasPromptOverride(promptName);
  const currentContent = getPromptContent(promptName);

  const sourceLabel = isOverridden
    ? tl("mcp.dialog.using_custom")
    : tl("mcp.dialog.using_default", [VERSION]);

  overrideDialog = new Dialog({
    id: "mcp_prompt_override",
    title: `${tl("mcp.dialog.edit_override")}: ${promptDef.title || promptName}`,
    width: 700,
    lines: [
      `<p style="margin-bottom: 8px; color: var(--color-subtle_text);">
        ${promptDef.description}
      </p>`,
      `<p style="margin-bottom: 12px; font-size: 11px;">
        <span style="
          display: inline-block;
          padding: 2px 8px;
          border-radius: 3px;
          background: ${isOverridden ? "var(--color-accent)" : "var(--color-back)"};
          color: ${isOverridden ? "var(--color-light)" : "var(--color-subtle_text)"};
          font-weight: ${isOverridden ? "bold" : "normal"};
        ">${sourceLabel}</span>
      </p>`,
      `<textarea id="mcp_override_textarea" style="
        width: 100%;
        min-height: 350px;
        padding: 12px;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        background: var(--color-back);
        color: var(--color-text);
        font-family: var(--font-code);
        font-size: 12px;
        line-height: 1.5;
        resize: vertical;
        tab-size: 2;
      ">${escapeForTextarea(currentContent)}</textarea>`,
    ],
    buttons: [
      tl("mcp.dialog.save_override"),
      tl("mcp.dialog.reset_to_default"),
      tl("mcp.dialog.cancel"),
    ],
    onButton(buttonIndex: number) {
      if (buttonIndex === 0) {
        // Save Override
        const textarea = document.getElementById(
          "mcp_override_textarea"
        ) as HTMLTextAreaElement | null;
        if (textarea) {
          setPromptOverride(promptName, textarea.value);
          document.dispatchEvent(new CustomEvent(PROMPT_OVERRIDE_CHANGED, { detail: { promptName } }));
          Blockbench.showQuickMessage(
            tl("mcp.dialog.override_saved"),
            1500
          );
        }
        return;
      }

      if (buttonIndex === 1) {
        // Reset to Default
        clearPromptOverride(promptName);
        document.dispatchEvent(new CustomEvent(PROMPT_OVERRIDE_CHANGED, { detail: { promptName } }));
        Blockbench.showQuickMessage(
          tl("mcp.dialog.override_reset"),
          1500
        );
        return;
      }

      // Cancel — default close behavior
    },
  });

  overrideDialog.show();
}

function escapeForTextarea(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
