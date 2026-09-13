import { describe, expect, test } from "bun:test";
import { canonical, isRecord, numbers, parseJsonRecord, record, records, sameCanonical, strings } from "./narrow";

describe("record narrowing", () => {
  test("accepts plain objects and rejects arrays, null and primitives", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    [[], null, undefined, 1, "text", true].forEach(value => expect(isRecord(value)).toBe(false));
    expect(record({ uuid: "x" }).uuid).toBe("x");
    expect(() => record([], "project")).toThrow("Expected project to be an object");
  });

  test("records narrows every item and names the failing index", () => {
    expect(records([{ type: "text" }, { type: "image" }]).map(item => item.type)).toEqual(["text", "image"]);
    expect(() => records({}, "content")).toThrow("Expected content to be an array");
    expect(() => records([{}, 2], "content")).toThrow("Expected content[1] to be an object");
  });
});

describe("array narrowing", () => {
  test("strings accepts only string arrays", () => {
    expect(strings(["a", "b"])).toEqual(["a", "b"]);
    expect(strings([])).toEqual([]);
    expect(() => strings(["a", 1], "face_keys")).toThrow("Expected face_keys to be an array of strings");
    expect(() => strings("a")).toThrow("array of strings");
  });

  test("numbers accepts only number arrays", () => {
    expect(numbers([0, -1.5, 2])[1]).toBe(-1.5);
    expect(() => numbers([0, "1"], "normal")).toThrow("Expected normal to be an array of numbers");
    expect(() => numbers(undefined)).toThrow("array of numbers");
  });
});

describe("canonical comparison", () => {
  test("sorts object keys recursively while preserving array order", () => {
    expect(JSON.stringify(canonical({ b: [{ d: 1, c: 2 }], a: null }))).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
    expect(canonical("text")).toBe("text");
  });

  test("sameCanonical ignores key order but not array order or values", () => {
    expect(sameCanonical({ x: 1, y: { b: 2, a: 1 } }, { y: { a: 1, b: 2 }, x: 1 })).toBe(true);
    expect(sameCanonical([1, 2], [2, 1])).toBe(false);
    expect(sameCanonical({ x: 1 }, { x: 2 })).toBe(false);
  });
});

describe("JSON parsing", () => {
  test("returns parsed objects", () => {
    expect(parseJsonRecord('{"index":3}', "get_undo_stack").index).toBe(3);
  });

  test("keeps the parser error as the cause and rejects non-object JSON", () => {
    const failure = (() => {
      try {
        parseJsonRecord("{broken", "export");
      } catch (error: unknown) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error && failure.message).toBe("export is not a valid JSON object");
    expect(failure instanceof Error && failure.cause).toBeInstanceOf(SyntaxError);
    expect(() => parseJsonRecord("[1]", "export")).toThrow("export is not a valid JSON object");
  });
});
