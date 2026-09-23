import { describe, expect, test } from "bun:test";
import { creatureModel } from "../test-fixtures";
import { isCube } from "../document/schema";
import { emptyModel } from "../tools/edit";
import { matchesName } from "../tools/inspect";
import { applyOperations, operationSchema } from "./operations";

const ops = (list: unknown[]) => operationSchema.array().parse(list);

describe("caller-supplied UUIDs", () => {
  test("a UUID already in the model is refused", () => {
    const uuid = crypto.randomUUID();
    expect(() => applyOperations(creatureModel(), ops([
      { op: "add_group", name: "a", uuid },
      { op: "add_group", name: "b", uuid },
    ]))).toThrow("already used");
  });
});

describe("box UV sizes follow the format", () => {
  test("modded_entity keeps fractional sizes (box_uv_float_size), others floor them", () => {
    const cube = { op: "add_cube", name: "fin", from: [0, 0, 0], to: [2.5, 1, 1], box_uv: true };
    const northOf = (format: string): unknown => {
      const doc = applyOperations(emptyModel(format, "", true, { width: 64, height: 64 }), ops([cube])).doc;
      const [element] = doc.elements;
      return element && isCube(element) ? element.faces.north?.uv : undefined;
    };
    expect(northOf("modded_entity")).toEqual([1, 1, 3.5, 2]);
    expect(northOf("bedrock")).toEqual([1, 1, 3, 2]);
  });
});

describe("element name search", () => {
  test.each([
    ["leg_front_l", "leg_*", true],
    ["leg_front_l", "*_l", true],
    ["leg_front_l", "LEG*FRONT*L", true],
    ["leg_front_l", "front", true],
    ["leg_front_l", "arm*", false],
    ["a", "a*a", false],
  ])("%s matches %s: %p", (name, pattern, expected) => {
    expect(matchesName(name, pattern)).toBe(expected);
  });

  test("patterns that would backtrack catastrophically as regexes finish immediately", () => {
    const started = performance.now();
    expect(matchesName(`${"a".repeat(5000)}!`, "(a+)+$")).toBe(false);
    expect(matchesName("a".repeat(5000), `${"*a".repeat(100)}*`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
