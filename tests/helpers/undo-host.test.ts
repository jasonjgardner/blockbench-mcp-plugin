import { beforeEach, describe, expect, test } from "bun:test";
import { required } from "./assertions";
import { createUndoHost } from "./undo-host";

type Lines = readonly string[];

interface IDocumentAspects {
  readonly scope: string;
}

interface IRestoreCall {
  readonly target: Lines;
  readonly reference: Lines;
}

let lines: string[];
let snapshotScopes: string[];
let restores: IRestoreCall[];

function createDocumentHost(strict?: boolean) {
  return createUndoHost({
    restore: (target: Lines, reference: Lines) => {
      restores = [...restores, { reference, target }];
      lines = [...target];
    },
    snapshot: (aspects: IDocumentAspects): Lines => {
      snapshotScopes = [...snapshotScopes, aspects.scope];
      return [...lines];
    },
    strict,
  });
}

function commitLine(host: ReturnType<typeof createDocumentHost>, line: string): void {
  host.initEdit({ scope: "document" });
  lines = [...lines, line];
  host.finishEdit(`add ${line}`);
}

beforeEach(() => {
  lines = ["original"];
  snapshotScopes = [];
  restores = [];
});

describe("transactions", () => {
  test("initEdit exposes the pending snapshot as current_save and counts the start", () => {
    const host = createDocumentHost();
    const before = host.initEdit({ scope: "document" });
    lines = [...lines, "edited"];
    expect(before).toEqual(["original"]);
    expect(host.current_save).toBe(before);
    expect(host.pending).toEqual({ aspects: { scope: "document" }, before });
    expect(host.starts).toBe(1);
    expect(host.history).toEqual([]);
  });

  test("finishEdit commits before/after/message, clears the pending edit, and advances index", () => {
    const host = createDocumentHost();
    commitLine(host, "first");
    expect(host.history).toEqual([{ after: ["original", "first"], before: ["original"], message: "add first" }]);
    expect(host.lastEdit).toBe(host.history[0]);
    expect(host.pending).toBeUndefined();
    expect(host.current_save).toBeUndefined();
    expect(host.index).toBe(1);
    expect(host.finishes).toBe(1);
  });

  test("finishEdit snapshots explicit post-edit aspects instead of the initial ones", () => {
    const host = createDocumentHost();
    host.initEdit({ scope: "initial" });
    host.finishEdit("post", { scope: "post" });
    expect(snapshotScopes).toEqual(["initial", "post"]);
  });

  test("history arrays are replaced rather than mutated", () => {
    const host = createDocumentHost();
    commitLine(host, "first");
    const earlier = host.history;
    commitLine(host, "second");
    expect(earlier).toHaveLength(1);
    expect(host.history).toHaveLength(2);
  });
});

describe("undo and redo", () => {
  test("restore the committed snapshots with the replaced state as reference", () => {
    const host = createDocumentHost();
    commitLine(host, "first");
    host.undo();
    expect(lines).toEqual(["original"]);
    expect(host.index).toBe(0);
    host.redo();
    expect(lines).toEqual(["original", "first"]);
    expect(host.index).toBe(1);
    expect(restores).toEqual([
      { reference: ["original", "first"], target: ["original"] },
      { reference: ["original"], target: ["original", "first"] },
    ]);
  });

  test("a new edit after undo discards the redo tail like Blockbench", () => {
    const host = createDocumentHost();
    commitLine(host, "first");
    commitLine(host, "second");
    host.undo();
    commitLine(host, "replacement");
    expect(host.history.map((entry) => entry.message)).toEqual(["add first", "add replacement"]);
    expect(host.index).toBe(2);
    expect(() => host.redo()).toThrow("Nothing to redo.");
  });
});

describe("cancelEdit", () => {
  test("reverts to current_save using the live state as reference when revert is true", () => {
    const host = createDocumentHost();
    host.initEdit({ scope: "document" });
    lines = [...lines, "partial"];
    host.cancelEdit(true);
    expect(lines).toEqual(["original"]);
    expect(restores).toEqual([{ reference: ["original", "partial"], target: ["original"] }]);
    expect(host.pending).toBeUndefined();
    expect(host.history).toEqual([]);
    expect(host.cancels).toBe(1);
  });

  test("keeps the live state by default and ignores calls without a pending edit", () => {
    const host = createDocumentHost();
    host.cancelEdit(true);
    expect(host.cancels).toBe(0);
    host.initEdit({ scope: "document" });
    lines = [...lines, "kept"];
    host.cancelEdit();
    expect(lines).toEqual(["original", "kept"]);
    expect(restores).toEqual([]);
    expect(host.pending).toBeUndefined();
  });
});

describe("strictness", () => {
  test("strict hosts reject nested, unmatched, and out-of-range operations", () => {
    const host = createDocumentHost();
    expect(() => host.finishEdit("unmatched")).toThrow("without a pending undo transaction");
    expect(() => host.undo()).toThrow("Nothing to undo.");
    expect(() => host.redo()).toThrow("Nothing to redo.");
    host.initEdit({ scope: "outer" });
    expect(() => host.initEdit({ scope: "inner" })).toThrow("Nested undo transaction");
    expect(host.starts).toBe(1);
  });

  test("non-strict hosts mirror native silent no-ops and replace a nested pending edit", () => {
    const host = createDocumentHost(false);
    expect(host.finishEdit("unmatched")).toBeUndefined();
    host.undo();
    host.redo();
    expect(restores).toEqual([]);
    host.initEdit({ scope: "outer" });
    lines = [...lines, "between"];
    host.initEdit({ scope: "inner" });
    expect(host.current_save).toEqual(["original", "between"]);
    expect(host.starts).toBe(2);
  });
});

describe("host variants", () => {
  test("void aspects allow initEdit() without arguments", () => {
    let pixels = ["original"];
    const host = createUndoHost<Lines>({ restore: (target) => { pixels = [...target]; }, snapshot: () => [...pixels] });
    host.initEdit();
    pixels = [...pixels, "stroke"];
    host.finishEdit();
    host.undo();
    expect(pixels).toEqual(["original"]);
    expect(required(host.lastEdit, "stroke entry").after).toEqual(["original", "stroke"]);
  });

  test("members are merged without freezing host getters", () => {
    let selections = 0;
    const host = createUndoHost(
      { restore: () => {}, snapshot: (aspects: IDocumentAspects) => aspects.scope },
      { finishSelection: () => { selections++; }, initSelection: () => {} },
    );
    host.initSelection();
    host.finishSelection();
    host.initEdit({ scope: "live" });
    expect(host.current_save).toBe("live");
    expect(selections).toBe(1);
  });

  test("reset clears history, pending edits, and counters", () => {
    const host = createDocumentHost();
    commitLine(host, "first");
    host.initEdit({ scope: "document" });
    host.cancelEdit();
    host.initEdit({ scope: "document" });
    host.reset();
    expect([host.history, host.pending, host.index, host.starts, host.finishes, host.cancels]).toEqual([[], undefined, 0, 0, 0, 0]);
    expect(() => host.initEdit({ scope: "document" })).not.toThrow();
  });
});
