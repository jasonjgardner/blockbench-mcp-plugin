/// <reference types="blockbench-types" />
import { z } from "zod";
import { getAllPromptDefinitions } from "@/lib/factories";

interface FormElementOptions {
  label?: string;
  description?: string;
  type?: string;
  value?: unknown;
  placeholder?: string;
  options?: Record<string, string>;
}

type InputFormConfig = Record<string, "_" | FormElementOptions>;

/**
 * Extracts metadata from a Zod schema type for form generation
 */
function getZodTypeMeta(zodType: z.ZodType): {
  type: string;
  isOptional: boolean;
  description?: string;
  defaultValue?: unknown;
  enumValues?: string[];
} {
  const def = zodType._def as Record<string, unknown>;
  const typeName = def.typeName as string;

  let isOptional = false;
  let description = def.description as string | undefined;
  let defaultValue: unknown = undefined;
  let enumValues: string[] | undefined;

  // Unwrap optional/nullable/default types
  if (typeName === "ZodOptional" || typeName === "ZodNullable") {
    isOptional = true;
    const inner = def.innerType as z.ZodType;
    const innerMeta = getZodTypeMeta(inner);
    return { ...innerMeta, isOptional: true };
  }

  if (typeName === "ZodDefault") {
    defaultValue = (def.defaultValue as () => unknown)?.();
    const inner = def.innerType as z.ZodType;
    const innerMeta = getZodTypeMeta(inner);
    return { ...innerMeta, defaultValue, isOptional: true };
  }

  // Handle enum types
  if (typeName === "ZodEnum") {
    enumValues = def.values as string[];
  }

  // Map Zod types to form types
  let type = "text";
  switch (typeName) {
    case "ZodString":
      type = "text";
      break;
    case "ZodNumber":
      type = "number";
      break;
    case "ZodBoolean":
      type = "checkbox";
      break;
    case "ZodEnum":
      type = "select";
      break;
    default:
      type = "text";
  }

  return {
    type,
    isOptional,
    description,
    defaultValue,
    enumValues,
  };
}

/**
 * Converts a Zod schema to Blockbench InputFormConfig
 */
function zodSchemaToFormConfig(
  argsSchema: Record<string, z.ZodType>
): InputFormConfig {
  const formConfig: InputFormConfig = {};

  for (const [fieldName, zodType] of Object.entries(argsSchema)) {
    const meta = getZodTypeMeta(zodType);

    const fieldConfig: FormElementOptions = {
      label: `${fieldName}${meta.isOptional ? "" : " *"}`,
      description: meta.description || `Argument: ${fieldName}`,
      type: meta.type,
    };

    // Set default value
    if (meta.defaultValue !== undefined) {
      fieldConfig.value = meta.defaultValue;
    }

    // Handle placeholder from description
    if (meta.description) {
      fieldConfig.placeholder = meta.description;
    }

    // Handle enum options
    if (meta.enumValues) {
      fieldConfig.options = { "": "(none)" };
      for (const val of meta.enumValues) {
        fieldConfig.options[val] = val;
      }
    }

    formConfig[fieldName] = fieldConfig;
  }

  return formConfig;
}

/**
 * Escapes HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

let contentDialog: Dialog | null = null;

/**
 * Shows the generated prompt content in a dialog
 */
function showPromptContentDialog(
  promptName: string,
  content: string,
  isError: boolean = false
) {
  contentDialog?.hide();

  contentDialog = new Dialog({
    id: "mcp_prompt_content",
    title: tl("mcp.dialog.prompt_title", [promptName]),
    width: 700,
    lines: [
      `<pre style="
        background: var(--color-back);
        padding: 12px;
        border-radius: 4px;
        overflow: auto;
        max-height: 500px;
        white-space: pre-wrap;
        word-break: break-word;
        color: ${isError ? "var(--color-error)" : "var(--color-text)"};
        font-family: var(--font-code);
        font-size: 12px;
        line-height: 1.5;
      ">${escapeHtml(content)}</pre>`,
    ],
    buttons: [tl("mcp.dialog.copy"), tl("mcp.dialog.close")],
    onButton(buttonIndex: number) {
      if (buttonIndex === 0) {
        navigator.clipboard.writeText(content).then(() => {
          Blockbench.showQuickMessage(tl("mcp.dialog.prompt_copied"), 1500);
        }).catch(() => {
          Blockbench.showQuickMessage(tl("mcp.dialog.copy_failed"), 1500);
        });
        return false; // Keep dialog open
      }
    },
  });

  contentDialog.show();
}

let currentDialog: Dialog | null = null;

/**
 * Opens a dialog to preview an MCP prompt
 */
export function openPromptPreviewDialog(promptName: string) {
  const promptDefs = getAllPromptDefinitions();
  const promptDef = promptDefs[promptName];

  if (!promptDef) {
    Blockbench.showQuickMessage(tl("mcp.dialog.prompt_not_found", [promptName]), 2000);
    return;
  }

  // Close any existing dialog
  currentDialog?.hide();

  const hasArgs = promptDef.argsSchema && Object.keys(promptDef.argsSchema).length > 0;
  const formConfig = hasArgs ? zodSchemaToFormConfig(promptDef.argsSchema!) : {};

  currentDialog = new Dialog({
    id: "mcp_prompt_preview",
    title: promptDef.title || promptName,
    width: 500,
    form: hasArgs ? formConfig : undefined,
    lines: [
      `<p style="margin-bottom: 12px; color: var(--color-subtle_text);">${escapeHtml(promptDef.description)}</p>`,
      ...(hasArgs ? [] : [`<p style="color: var(--color-subtle_text); font-style: italic;">${tl("mcp.dialog.no_arguments")}</p>`]),
    ],
    buttons: [tl("mcp.dialog.generate_prompt"), tl("mcp.dialog.cancel")],
    confirmIndex: 0,
    cancelIndex: 1,
    async onConfirm(formResult: Record<string, unknown>) {
      // Filter out empty values for optional args
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(formResult)) {
        if (value !== "" && value !== undefined && value !== null) {
          args[key] = value;
        }
      }

      Blockbench.showQuickMessage(tl("mcp.dialog.generating_prompt"), 1000);

      try {
        const result = await promptDef.generate(args);

        // Extract text content from messages
        const content = result.messages
          .map((msg) => {
            const roleLabel = msg.role === "user" ? tl("mcp.dialog.role_user") : tl("mcp.dialog.role_assistant");
            const text = typeof msg.content === "string"
              ? msg.content
              : msg.content.text;
            return `[${roleLabel}]\n${text}`;
          })
          .join("\n\n---\n\n");

        showPromptContentDialog(promptName, content);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showPromptContentDialog(promptName, `Error: ${errorMessage}`, true);
      }
    },
  });

  currentDialog.show();
}

/**
 * Gets prompt info for display in UI
 */
export function getPromptInfo(promptName: string): {
  name: string;
  title: string;
  description: string;
  argumentCount: number;
} | null {
  const promptDefs = getAllPromptDefinitions();
  const promptDef = promptDefs[promptName];

  if (!promptDef) return null;

  return {
    name: promptName,
    title: promptDef.title,
    description: promptDef.description,
    argumentCount: promptDef.argsSchema ? Object.keys(promptDef.argsSchema).length : 0,
  };
}
