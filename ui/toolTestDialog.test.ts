import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { z } from "zod";
import { createTool, removeTool } from "@/lib/factories";
import { useGlobals } from "@/tests/helpers/globals";
import { openToolTestDialog } from "@/ui/toolTestDialog";

interface IDialogOptions {
  id: string;
  lines?: string[];
  onConfirm?: (values: Record<string, unknown>) => void;
}

let dialogs: IDialogOptions[] = [];
let shown: Promise<IDialogOptions>;
let resultShown: (result: IDialogOptions) => void;
const name = "audit_panel_validation";

class HostDialog {
  constructor(readonly options: IDialogOptions) { dialogs.push(this.options); }
  hide(): void {}
  show(): void {
    if (this.options.id === "mcp_tool_result") resultShown(this.options);
  }
}

beforeEach(() => {
  dialogs = [];
  shown = new Promise(resolve => { resultShown = resolve; });
});
afterEach(() => { removeTool(name); });
useGlobals(() => ({
  Dialog: HostDialog,
  Blockbench: { showQuickMessage() {} },
  tl: (key: string) => key,
}));

async function confirm(values: Record<string, unknown>): Promise<IDialogOptions> {
  openToolTestDialog(name);
  const dialog = dialogs.find(option => option.id === "mcp_tool_test");
  if (!dialog?.onConfirm) throw new Error("Tool test dialog did not open.");
  dialog.onConfirm(values);
  return shown;
}

test("rejects invalid fields and cross-field refinements before executing", async () => {
  const execute = mock(async () => "done");
  createTool(name, {
    description: "Validate a range.",
    parameters: z.object({ left: z.number(), right: z.number() })
      .refine(async ({ left, right }) => left < right, { message: "left must be less than right" }),
    execute,
  });
  const invalid = await confirm({ left: 5, right: 1 });
  expect(invalid.lines?.join("")).toContain("left must be less than right");
  expect(execute).not.toHaveBeenCalled();
});

test("reports JSON shape errors instead of passing malformed arrays to the tool", async () => {
  const execute = mock(async () => "done");
  createTool(name, { description: "Validate array.", parameters: z.object({ values: z.array(z.number()) }), execute });
  const invalid = await confirm({ values: "not JSON" });
  expect(invalid.lines?.join("")).toContain("Expected array");
  expect(execute).not.toHaveBeenCalled();
});

test("applies defaults and asynchronous transforms exactly once", async () => {
  const transform = mock(async (value: string) => value.toUpperCase());
  const execute = mock(async (args: { label: string; count: number }) => JSON.stringify(args));
  createTool(name, {
    description: "Parse inputs.",
    parameters: z.object({
      label: z.string().transform(transform),
      count: z.number().default(2),
    }).transform(value => ({ ...value, count: value.count + 1 })),
    execute,
  });
  await confirm({ label: "hello", count: "" });
  expect(transform).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]?.[0]).toEqual({ label: "HELLO", count: 3 });
});
