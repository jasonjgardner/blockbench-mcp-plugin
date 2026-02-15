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
      "Whether or not to automatically confirm any dialogs that appear as a result of the action."
    ),
  confirmEvent: z
    .string()
    .optional()
    .describe("Stringified form of event arguments."),
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
    description: "Triggers an action in the Blockbench editor.",
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
      "Evaluates the given expression and logs it to the console. Do not pass `console` commands as they will not work.",
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

export function registerUITools() {
  createTool(
    uiToolDocs[0].name,
    {
      ...uiToolDocs[0],
      async execute({ action, confirmEvent: args, confirmDialog }) {
        Undo.initEdit({
          elements: [],
          outliner: true,
          collections: [],
        });
        const parsedArgs = args ? JSON.parse(args) : {};

        if (!(action in BarItems)) {
          throw new Error(`Action "${action}" not found.`);
        }
        const barItem = BarItems[action];

        if (barItem && barItem instanceof Action) {
          const { event, ...rest } = parsedArgs;
          barItem.trigger(
            new Event(event || "click", {
              ...rest,
            })
          );
        }

        if (confirmDialog) {
          Dialog.open?.confirm();
        }

        Undo.finishEdit("Agent triggered action");

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
          Undo.initEdit({
            elements: [],
            outliner: true,
            collections: [],
          });

          const result = await eval(code.trim());

          if (result !== undefined) {
            return JSON.stringify(result);
          }

          return "(Code executed successfully, but no result was returned.)";
        } catch (error) {
          return `Error executing code: ${error}`;
        } finally {
          Undo.finishEdit("Agent executed code");
        }
      },
    },
    uiToolDocs[1].status
  );

  createTool(
    uiToolDocs[2].name,
    {
      ...uiToolDocs[2],
      async execute({ position, drag }) {
        // Emulate a click at the specified position
        const { x, y, button } = position;
        const mouseEvent = new MouseEvent("click", {
          clientX: x,
          clientY: y,
          button: button === "left" ? 0 : 2,
        });
        document.dispatchEvent(mouseEvent);
        if (drag) {
          const { to, duration } = drag;
          const dragStartEvent = new MouseEvent("mousedown", {
            clientX: x,
            clientY: y,
            button: button === "left" ? 0 : 2,
          });
          const dragEndEvent = new MouseEvent("mouseup", {
            clientX: to.x,
            clientY: to.y,
            button: button === "left" ? 0 : 2,
          });
          document.dispatchEvent(dragStartEvent);
          await new Promise((resolve) => setTimeout(resolve, duration));
          document.dispatchEvent(dragEndEvent);
        }

        // Capture a screenshot after the click
        return await captureAppScreenshot();
      },
    },
    uiToolDocs[2].status
  );

  createTool(
    uiToolDocs[3].name,
    {
      ...uiToolDocs[3],
      async execute({ values, confirm }) {
        if (!Dialog.stack.length) {
          throw new Error("No dialogs found in the Blockbench editor.");
        }
        if (!Dialog.open) {
          Dialog.stack[Dialog.stack.length - 1]?.focus();
        }
        const parsedValues = JSON.parse(values);

        const keys = Object.keys(Dialog.open?.getFormResult() ?? {});
        const valuesToFill = Object.entries(parsedValues).reduce(
          (acc, [key, value]) => {
            if (keys.includes(key)) {
              acc[key as keyof FormResultValue] = value as FormResultValue;
            }
            return acc;
          }
        ) as Record<keyof FormResultValue, FormResultValue>;
        Dialog.open?.setFormValues(valuesToFill, true);

        if (confirm) {
          Dialog.open?.confirm();
        } else {
          Dialog.open?.cancel();
        }

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
