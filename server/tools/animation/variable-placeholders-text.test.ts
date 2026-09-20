import { describe, expect, test } from "bun:test";
import {
  appendPlaceholderLine,
  buildPlaceholderLine,
  normalizePlaceholderVariable,
  parsePlaceholderLines,
  removePlaceholderVariable,
  upsertPlaceholderLine,
} from "./variable-placeholders-text";
import { variablePlaceholderEntrySchema, variablePlaceholdersParameters } from "./schemas";

describe("buildPlaceholderLine matches the native Create Variable Placeholder dialog", () => {
  test.each([
    [{ type: "value", variable: "variable.speed", value: 2 }, "variable.speed = 2"],
    [{ type: "value", variable: "v.walk", value: "math.sin(q.anim_time * 90)" }, "v.walk = math.sin(q.anim_time * 90)"],
    [{ type: "slider", variable: "variable.bend", name: "bend" }, "variable.bend = slider('bend')"],
    [{ type: "slider", variable: "variable.bend", name: "bend", step: 0.5 }, "variable.bend = slider('bend', 0.5)"],
    [{ type: "slider", variable: "variable.bend", name: "bend", range: [-1, 1] }, "variable.bend = slider('bend', 1, -1, 1)"],
    [{ type: "slider", variable: "variable.bend", name: "bend", step: 0.1, range: [0, 2] }, "variable.bend = slider('bend', 0.1, 0, 2)"],
    [{ type: "toggle", variable: "variable.open", name: "Open" }, "variable.open = toggle('Open')"],
    [{ type: "impulse", variable: "variable.hit", name: "hit" }, "variable.hit = impulse('hit')"],
    [{ type: "impulse", variable: "variable.hit", name: "hit", duration: 0.25 }, "variable.hit = impulse('hit', 0.25)"],
  ] as const)("%o", (entry, expected) => {
    expect(buildPlaceholderLine(variablePlaceholderEntrySchema.parse(entry))).toBe(expected);
  });
});

describe("parsing mirrors processVariablePlaceholderText", () => {
  test("expands short prefixes and strips whitespace and semicolons", () => {
    expect(normalizePlaceholderVariable(" v.speed ;")).toBe("variable.speed");
    expect(normalizePlaceholderVariable("q.is_sneaking")).toBe("query.is_sneaking");
    expect(normalizePlaceholderVariable("t.x")).toBe("temp.x");
    expect(normalizePlaceholderVariable("c.item")).toBe("context.item");
    expect(normalizePlaceholderVariable("variable.v.x")).toBe("variable.v.x");
  });

  test("skips lines without a right-hand side and splits at the first equals sign", () => {
    const text = "// comment\nv.speed = 2\n\nquery.head_x_rotation = 10;\nvariable.cmp = q.x == 1\nbroken =";
    expect(parsePlaceholderLines(text)).toEqual([
      { variable: "variable.speed", expression: "2" },
      { variable: "query.head_x_rotation", expression: "10;" },
      { variable: "variable.cmp", expression: "q.x == 1" },
    ]);
  });
});

describe("text edits are immutable and alias-aware", () => {
  test("append trims trailing whitespace like the native dialog", () => {
    expect(appendPlaceholderLine("", "v.a = 1")).toBe("v.a = 1");
    expect(appendPlaceholderLine("v.a = 1\n\n  ", "v.b = 2")).toBe("v.a = 1\nv.b = 2");
  });

  test("upsert replaces the first assignment, drops later duplicates and keeps other lines", () => {
    const text = "v.a = 1\nvariable.b = 2\nvariable.a = 3";
    expect(upsertPlaceholderLine(text, "variable.a", "variable.a = 9")).toEqual({
      text: "variable.a = 9\nvariable.b = 2",
      replaced: true,
    });
    expect(text).toBe("v.a = 1\nvariable.b = 2\nvariable.a = 3");
  });

  test("upsert appends when the variable is new", () => {
    expect(upsertPlaceholderLine("v.a = 1\n", "v.c", "v.c = 4")).toEqual({ text: "v.a = 1\nv.c = 4", replaced: false });
  });

  test("remove deletes every assignment of the variable", () => {
    expect(removePlaceholderVariable("v.a = 1\nv.b = 2\nvariable.a = slider('a')", "variable.a")).toEqual({ text: "v.b = 2", removed: 2 });
    expect(removePlaceholderVariable("v.b = 2", "v.a")).toEqual({ text: "v.b = 2", removed: 0 });
  });
});

describe("schemas reject lines the native parser would misread", () => {
  test.each([
    { type: "toggle", variable: "variable.open", name: "it's" },
    { type: "slider", variable: "variable.bend", name: "a,b" },
    { type: "value", variable: "variable x", value: 1 },
    { type: "value", variable: "variable.x", value: "1\nv.y = 2" },
    { type: "impulse", variable: "variable.hit", name: "hit", duration: 0 },
  ])("%o", (entry) => {
    expect(variablePlaceholderEntrySchema.safeParse(entry).success).toBe(false);
  });

  test("replace_existing defaults to true", () => {
    expect(variablePlaceholdersParameters.parse({ action: "get" })).toEqual({ action: "get", replace_existing: true });
  });
});
