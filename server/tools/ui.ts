/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { captureAppScreenshot } from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { mouseButtonEnum, coordinateSchema } from "@/lib/zodObjects";

// ============================================================================
// UI Tool Parameter Schemas
// ============================================================================

/** Parameters for triggering an action */
export const triggerActionParametersSchema = z.object({
  action: z
    .string()
    .describe("Action ID from Blockbench's BarItems registry."),
  confirmDialog: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Whether to confirm a newly opened dialog from this action. Existing unrelated dialogs are never confirmed."
    ),
  confirmEvent: z
    .string()
    .optional()
    .describe("JSON object of MouseEvent options, with optional event type (default click)."),
});

/** Parameters for risky eval */
export const riskyEvalParametersSchema = z.object({
  code: z
    .string()
    .refine((val) => !/console\.|\/\/|\/\*/.test(val), {
      message:
        "Code must not include 'console.', '//' or '/* */' comments.",
    })
    .describe(
      "JavaScript code to evaluate. Do not pass `console` commands or comments."
    ),
});

/** Click position with optional button */
export const clickPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  button: mouseButtonEnum.optional().default("left").describe("Mouse button to use."),
});

/** Drag parameters */
export const dragParametersSchema = z
  .object({
    to: coordinateSchema,
    duration: z
      .number()
      .optional()
      .default(100)
      .describe("Duration of the drag in milliseconds."),
  })
  .optional()
  .describe("Drag options. If set, will perform a drag from position to 'to'.");

/** Parameters for emulating clicks */
export const emulateClicksParametersSchema = z.object({
  position: clickPositionSchema,
  drag: dragParametersSchema,
});

/** Parameters for filling a dialog */
export const fillDialogParametersSchema = z.object({
  values: z
    .string()
    .describe("Stringified form of values to fill the dialog with."),
  confirm: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Whether to confirm or cancel the dialog after filling it. True to confirm, false to cancel."
    ),
});

// ============================================================================
// UI Tool Docs
// ============================================================================

export const uiToolDocs: ToolSpec[] = [
  {
    name: "trigger_action",
    description: "Triggers an available Blockbench Action and respects its condition. The native action owns Undo; only a newly opened dialog may be auto-confirmed.",
    annotations: {
      title: "Trigger Action",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: triggerActionParametersSchema,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "risky_eval",
    description:
      "Evaluates JavaScript and returns its JSON result. Does not create an Undo entry. Mutating code must manage its own correctly scoped Undo transaction; read-only evaluation leaves history unchanged.",
    annotations: {
      title: "Eval",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: riskyEvalParametersSchema,
    status: STATUS_STABLE,
  },
  {
    name: "emulate_clicks",
    description: "Emulates clicks on the given interface elements.",
    annotations: {
      title: "Emulate Clicks",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: emulateClicksParametersSchema,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "fill_dialog",
    description: "Fills the dialog with the given values.",
    annotations: {
      title: "Fill Dialog",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: fillDialogParametersSchema,
    status: STATUS_EXPERIMENTAL,
  },
];

function parseObjectJSON(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object.`);
  return parsed as Record<string, unknown>;
}

/** Register UI bridges without wrapping native action/evaluation transactions in a second Undo edit. */
export function registerUITools(): void {
  createTool(
    uiToolDocs[0].name,
    {
      ...uiToolDocs[0],
      parameters: triggerActionParametersSchema,
      async execute({ action, confirmEvent: args, confirmDialog }) {
        const parsedArgs = args ? parseObjectJSON(args, "confirmEvent") : {};
        if (!Object.hasOwn(BarItems, action)) {
          throw new Error(`Action "${action}" not found.`);
        }
        const barItem = BarItems[action];
        if (!(barItem instanceof Action)) throw new Error(`Bar item "${action}" is not a triggerable Action.`);
        const { event = "click", ...rest } = parsedArgs;
        if (typeof event !== "string" || !event) throw new Error("confirmEvent.event must be a nonempty event type string.");
        const previousDialogs = new Set([...Dialog.stack, ...(Dialog.open ? [Dialog.open] : [])]);
        const triggered = barItem.trigger(new MouseEvent(event, rest));
        if (triggered === false) throw new Error(`Action "${action}" is unavailable in the current mode, format, or selection.`);
        const opened = Dialog.open;
        if (confirmDialog && opened && !previousDialogs.has(opened)) {
          opened.confirm();
        }

        let result;

        try {
          result = await captureAppScreenshot();
        } catch (e) {
          result = `Action "${action}" executed, but failed to capture app screenshot: ${e}`;
        }

        return result;
      },
    },
    uiToolDocs[0].status
  );

  createTool(
    uiToolDocs[1].name,
    {
      ...uiToolDocs[1],
      async execute({ code }) {
        try {
          const result = await eval(code.trim());

          if (result !== undefined) {
            return JSON.stringify(result);
          }

          return "(Code executed successfully, but no result was returned.)";
        } catch (error) {
          throw new Error(`Error executing code: ${error}`);
        }
      },
    },
    uiToolDocs[1].status
  );

  createTool(
    uiToolDocs[2].name,
    {
      ...uiToolDocs[2],
      parameters: emulateClicksParametersSchema,
      async execute({ position, drag }) {
        const { x, y, button } = position;
        const target = document.elementFromPoint(x, y);
        if (!target) throw new Error("No interface element exists at the requested position.");
        const mouseButton = button === "left" ? 0 : 2;
        const dispatch = (element: Element, type: string, point: { x: number; y: number }, pressed = false): void => {
          element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: point.x, clientY: point.y, button: mouseButton, buttons: pressed ? (mouseButton === 0 ? 1 : 2) : 0 }));
        };
        dispatch(target, "mousedown", position, true);
        if (!drag) {
          dispatch(target, "mouseup", position);
          dispatch(target, mouseButton === 0 ? "click" : "contextmenu", position);
          return await captureAppScreenshot();
        }
        const destination = document.elementFromPoint(drag.to.x, drag.to.y) ?? target;
        dispatch(destination, "mousemove", drag.to, true);
        await new Promise(resolve => setTimeout(resolve, drag.duration));
        dispatch(destination, "mouseup", drag.to);
        return await captureAppScreenshot();
      },
    },
    uiToolDocs[2].status
  );

  createTool(
    uiToolDocs[3].name,
    {
      ...uiToolDocs[3],
      parameters: fillDialogParametersSchema,
      async execute({ values, confirm }) {
        if (!Dialog.stack.length) {
          throw new Error("No dialogs found in the Blockbench editor.");
        }
        if (!Dialog.open) {
          Dialog.stack[Dialog.stack.length - 1]?.focus();
        }
        const parsedValues = parseObjectJSON(values, "values");
        const keys = Object.keys(Dialog.open?.getFormResult() ?? {});
        const unknownKeys = Object.keys(parsedValues).filter(key => !keys.includes(key));
        if (unknownKeys.length) throw new Error(`Unknown dialog field(s): ${unknownKeys.join(", ")}. Inspect the current dialog fields before filling it.`);
        const valuesToFill = parsedValues as Record<string, FormResultValue>;
        Dialog.open?.setFormValues(valuesToFill, true);

        if (confirm) Dialog.open?.confirm();
        if (!confirm) Dialog.open?.cancel();

        return JSON.stringify({
          result: `Current dialog stack is now ${Dialog.stack.length} deep.`,
          dialogs: Dialog.stack.map((d) => ({
            id: d.id,
            values: d.getFormResult(),
          })),
        });
      },
    },
    uiToolDocs[3].status
  );
}
