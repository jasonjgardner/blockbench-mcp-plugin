/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import { captureAppScreenshot } from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";

export function registerUITools() {
createTool(
  "trigger_action",
  {
    description: "Triggers an action in the Blockbench editor.",
    annotations: {
      title: "Trigger Action",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      action: z
        .enum(Object.keys(BarItems) as [string, ...string[]])
        .describe("Action to trigger."),
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
    }),
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
  STATUS_EXPERIMENTAL
);

createTool(
  "risky_eval",
  {
    description:
      "Evaluates the given expression and logs it to the console. Do not pass `console` commands as they will not work.",
    annotations: {
      title: "Eval",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      code: z
        .string()
        .refine((val) => !/console\.|\/\/|\/\*/.test(val), {
          message:
            "Code must not include 'console.', '//' or '/* */' comments.",
        })
        .describe(
          "JavaScript code to evaluate. Do not pass `console` commands or comments."
        ),
    }),
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
  STATUS_STABLE
);

createTool(
  "emulate_clicks",
  {
    description: "Emulates clicks on the given interface elements.",
    annotations: {
      title: "Emulate Clicks",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      position: z.object({
        x: z.number(),
        y: z.number(),
        button: z
          .enum(["left", "right"])
          .optional()
          .default("left")
          .describe("Mouse button to use."),
      }),
      drag: z
        .object({
          to: z.object({
            x: z.number(),
            y: z.number(),
          }),
          duration: z
            .number()
            .optional()
            .default(100)
            .describe("Duration of the drag in milliseconds."),
        })
        .optional()
        .describe(
          "Drag options. If set, will perform a drag from position to 'to'."
        ),
    }),
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
  STATUS_EXPERIMENTAL
);

createTool(
  "fill_dialog",
  {
    description: "Fills the dialog with the given values.",
    annotations: {
      title: "Fill Dialog",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
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
    }),
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
  STATUS_EXPERIMENTAL
);
}
