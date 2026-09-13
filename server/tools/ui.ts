/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import { captureAppScreenshot } from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { mouseButtonEnum, coordinateSchema } from "@/lib/zodObjects";
import { parseObjectJSON, toFormValues, toMouseEventInit } from "@/server/tools/ui/json-input";

// ============================================================================
// UI Tool Parameter Schemas
// ============================================================================

/**
 * Parameters for triggering an action. `confirmEvent` is a JSON object string
 * such as `{"event":"click","shiftKey":true}`: the optional `event` member names
 * the event type passed to the action (default `click`), and the remaining
 * boolean/number members are forwarded as `MouseEventInit` options.
 */
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

/**
 * Specs for the UI bridge tools, shared by `registerUITools` and the docs
 * manifest. Registration reads entries by index, in this order:
 * `trigger_action`, `risky_eval`, `emulate_clicks`, `fill_dialog`.
 * Built without Blockbench globals so the doc generator can import it outside the host.
 */
export const uiToolDocs: IToolSpec[] = [
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

// ============================================================================
// UI Tool Implementations
// ============================================================================

/** Emulated mouse button name accepted by `emulate_clicks`. */
type MouseButton = z.infer<typeof mouseButtonEnum>;
/** Client-space point in CSS pixels, as used by click positions and drag targets. */
type ScreenPoint = z.infer<typeof coordinateSchema>;

/** `MouseEvent.button` codes identifying the button that changed state (0 primary, 2 secondary). */
const MOUSE_BUTTON = { left: 0, right: 2 } as const satisfies Record<MouseButton, number>;

/** `MouseEvent.buttons` bitmasks for a held button (1 primary, 2 secondary). */
const MOUSE_BUTTONS_MASK = { left: 1, right: 2 } as const satisfies Record<MouseButton, number>;

/** `MouseEvent.buttons` value once every button is released. */
const RELEASED_BUTTONS_MASK = 0;

/** Event the browser fires after a press and release: `click` for primary, `contextmenu` for secondary. */
const RELEASE_EVENT = { left: "click", right: "contextmenu" } as const satisfies Record<MouseButton, string>;

/** Returned by `risky_eval` when evaluated code yields `undefined`. */
const NO_RESULT_MESSAGE = "(Code executed successfully, but no result was returned.)";

/** Triggers a native Action, auto-confirming only a dialog the Action itself opened. */
async function triggerAction({ action, confirmEvent, confirmDialog }: z.infer<typeof triggerActionParametersSchema>) {
  const eventOptions = confirmEvent ? parseObjectJSON(confirmEvent, "confirmEvent") : {};
  if (!Object.hasOwn(BarItems, action)) {
    throw new Error(`Action "${action}" not found.`);
  }
  const barItem = BarItems[action];
  if (!(barItem instanceof Action)) throw new Error(`Bar item "${action}" is not a triggerable Action.`);
  const { event = "click", ...init } = eventOptions;
  if (typeof event !== "string" || !event) throw new Error("confirmEvent.event must be a nonempty event type string.");
  const previousDialogs = new Set([...Dialog.stack, ...(Dialog.open ? [Dialog.open] : [])]);
  const triggered = barItem.trigger(new MouseEvent(event, toMouseEventInit(init)));
  if (triggered === false) throw new Error(`Action "${action}" is unavailable in the current mode, format, or selection.`);
  const opened = Dialog.open;
  if (confirmDialog && opened && !previousDialogs.has(opened)) {
    opened.confirm();
  }

  return captureAppScreenshot().catch(
    (error: unknown) => `Action "${action}" executed, but failed to capture app screenshot: ${error}`
  );
}

/** Evaluates code in the plugin context and serializes a defined result as JSON. */
async function evaluateCode({ code }: z.infer<typeof riskyEvalParametersSchema>): Promise<string> {
  try {
    const result: unknown = await eval(code.trim());
    return result === undefined ? NO_RESULT_MESSAGE : JSON.stringify(result);
  } catch (error) {
    throw new Error(`Error executing code: ${error}`, { cause: error });
  }
}

/** Dispatches a press and release, or a press/move/release drag, then captures the app. */
async function emulateClicks({ position, drag }: z.infer<typeof emulateClicksParametersSchema>) {
  const { x, y, button } = position;
  const target = document.elementFromPoint(x, y);
  if (!target) throw new Error("No interface element exists at the requested position.");
  const dispatch = (element: Element, type: string, point: ScreenPoint, pressed = false): void => {
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: point.x,
      clientY: point.y,
      button: MOUSE_BUTTON[button],
      buttons: pressed ? MOUSE_BUTTONS_MASK[button] : RELEASED_BUTTONS_MASK,
    }));
  };
  dispatch(target, "mousedown", position, true);
  if (!drag) {
    dispatch(target, "mouseup", position);
    dispatch(target, RELEASE_EVENT[button], position);
    return await captureAppScreenshot();
  }
  const destination = document.elementFromPoint(drag.to.x, drag.to.y) ?? target;
  dispatch(destination, "mousemove", drag.to, true);
  await new Promise(resolve => setTimeout(resolve, drag.duration));
  dispatch(destination, "mouseup", drag.to);
  return await captureAppScreenshot();
}

/** Fills known fields of the open (or topmost) dialog, then confirms or cancels it. */
async function fillDialog({ values, confirm }: z.infer<typeof fillDialogParametersSchema>): Promise<string> {
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
  Dialog.open?.setFormValues(toFormValues(parsedValues), true);
  Dialog.open?.[confirm ? "confirm" : "cancel"]();

  return JSON.stringify({
    result: `Current dialog stack is now ${Dialog.stack.length} deep.`,
    dialogs: Dialog.stack.map((d) => ({
      id: d.id,
      values: d.getFormResult(),
    })),
  });
}

/**
 * Registers the UI bridge tools. Native actions and evaluated code own their
 * Undo transactions, so these tools never wrap them in a second Undo edit.
 */
export function registerUITools(): void {
  createTool(
    uiToolDocs[0].name,
    { ...uiToolDocs[0], parameters: triggerActionParametersSchema, execute: triggerAction },
    uiToolDocs[0].status
  );

  createTool(
    uiToolDocs[1].name,
    { ...uiToolDocs[1], parameters: riskyEvalParametersSchema, execute: evaluateCode },
    uiToolDocs[1].status
  );

  createTool(
    uiToolDocs[2].name,
    { ...uiToolDocs[2], parameters: emulateClicksParametersSchema, execute: emulateClicks },
    uiToolDocs[2].status
  );

  createTool(
    uiToolDocs[3].name,
    { ...uiToolDocs[3], parameters: fillDialogParametersSchema, execute: fillDialog },
    uiToolDocs[3].status
  );
}
