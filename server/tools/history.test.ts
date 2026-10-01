import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

let tools: IToolFixture;
const project = { saved: true };
const undo = createUndoHost<null, unknown>({ snapshot: () => null, restore: () => {} });

let editAspects: unknown;

/**
 * Blockbench's `Undo`: like `UndoSystem#finishEdit` in 5.2, a finished edit marks the
 * project unsaved unless its aspects (given to finishEdit, else to initEdit) set `keep_saved`.
 */
const nativeUndo = {
  get history() {
    return undo.history;
  },
  get index() {
    return undo.index;
  },
  initEdit: (aspects: unknown) => {
    editAspects = aspects;
    return undo.initEdit(aspects);
  },
  finishEdit: (message?: string, aspects?: unknown) => {
    const entry = undo.finishEdit(message);
    const used = aspects ?? editAspects;
    if (typeof used !== "object" || used === null || !Reflect.get(used, "keep_saved")) project.saved = false;
    return entry;
  },
};

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/history.ts"], register: ["registerHistoryTools"] });
});

beforeEach(() => undo.reset());

useGlobals(() => ({ Project: project, Undo: nativeUndo }));

describe("save_checkpoint", () => {
  test("adds a named history entry and keeps a saved project saved", async () => {
    project.saved = true;
    await tools.call("save_checkpoint", { name: "before legs" });
    expect(undo.history.map((entry) => entry.message)).toEqual(["[checkpoint] before legs"]);
    expect(project.saved).toBe(true);
  });

  test("leaves an unsaved project unsaved", async () => {
    project.saved = false;
    await tools.call("save_checkpoint", { name: "draft" });
    expect(project.saved).toBe(false);
  });
});
