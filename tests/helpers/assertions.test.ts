import { describe, expect, test } from "bun:test";
import { isRecord, required } from "./assertions";

describe("required", () => {
  test("returns present values unchanged, including falsy ones", () => {
    const values = [0, "", false, Number.NaN, [], {}];
    values.forEach((value) => expect(required(value, "value")).toBe(value));
  });

  test("names the label and the missing value", () => {
    expect(() => required(undefined, "last undo entry")).toThrow(new TypeError("Expected last undo entry to be present, but it was undefined."));
    expect(() => required(null, "Carrier group")).toThrow(new TypeError("Expected Carrier group to be present, but it was null."));
  });

  test("narrows optional lookups for later property access", () => {
    const groups = [{ name: "Carrier", uuid: "carrier" }];
    expect(required(groups.find((group) => group.name === "Carrier"), "Carrier group").uuid).toBe("carrier");
  });
});

describe("isRecord", () => {
  test("accepts plain objects, arrays, class instances, and null-prototype objects", () => {
    expect([{}, [], new Map(), Object.create(null)].map(isRecord)).toEqual([true, true, true, true]);
  });

  test("rejects null, primitives, symbols, and functions", () => {
    expect([null, undefined, 0, "text", true, Symbol("s"), () => ({})].map(isRecord)).toEqual([false, false, false, false, false, false, false]);
  });
});
