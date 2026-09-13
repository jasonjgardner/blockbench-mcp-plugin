import { expect, test } from "bun:test";
import { countProjectNodes, getHytaleTextureDimensionIssues, validateNodeCount } from "./hytale";
import { useGlobals } from "@/tests/helpers/globals";

useGlobals(() => ({
  Format: { id: "hytale_character" },
  Codecs: { blockymodel: { compile: (options: { raw: boolean }) => {
    expect(options).toEqual({ raw: true });
    return { nodes: [{ children: [{}, {}] }, {}] };
  } } },
}));

test("node validation counts native compiled nodes including nested children", () => {
  // Deliberately no Cube/Group globals: export folding and exclusions belong to the codec.
  expect(countProjectNodes()).toBe(4);
  expect(validateNodeCount()).toMatchObject({ valid: true, count: 4, max: 255 });
});

test("accepts JSON codec output and enforces the exported 255-node boundary", () => {
  Object.assign(globalThis, { Codecs: { blockymodel: { compile: () => JSON.stringify({ nodes: Array.from({ length: 256 }, () => ({})) }) } } });
  expect(validateNodeCount()).toMatchObject({ valid: false, count: 256, max: 255 });
});

test("does not substitute a heuristic for missing or invalid codec results", () => {
  Object.assign(globalThis, { Codecs: {} });
  expect(countProjectNodes).toThrow("unavailable");
  Object.assign(globalThis, { Codecs: { blockymodel: { compile: () => ({ nodes: [{}], children: [] }) } } });
  expect(countProjectNodes()).toBe(1);
  [undefined, { nodes: [null] }, { nodes: [{ children: {} }] }, { wrong: [] }].forEach(compiled => {
    Object.assign(globalThis, { Codecs: { blockymodel: { compile: () => compiled } } });
    expect(countProjectNodes).toThrow();
  });
});

test("does not compile outside Hytale", () => {
  Object.assign(globalThis, { Format: { id: "free" }, Codecs: { blockymodel: { compile: () => { throw new Error("Should not compile"); } } } });
  expect(countProjectNodes()).toBe(0);
});

test("rectangular multiples of 32 are valid independently of character density", () => {
  expect(getHytaleTextureDimensionIssues([
    { name: "character", width: 96, height: 32 },
    { name: "prop", width: 32, height: 160 },
    { name: "atlas", width: 256, height: 128 },
  ])).toEqual([]);
});

test.each([[33, 64], [64, 33], [0, 64], [64, 0], [-32, 64], [64, Infinity]])("invalid Hytale bitmap %s x %s reports both dimension requirements", (width, height) => {
  const issues = getHytaleTextureDimensionIssues([{ name: "atlas", width, height }]);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain("positive multiples of 32");
});
