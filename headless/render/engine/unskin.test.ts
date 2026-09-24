import { describe, expect, test } from "bun:test";

import { mergeDrawGroups, rigidBoneIndex } from "./unskin";

describe("rigidBoneIndex", () => {
  test("finds the single bone every vertex is fully weighted to", () => {
    expect(rigidBoneIndex([3, 0, 0, 0, 3, 0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0], 4)).toBe(3);
  });

  test("rejects blended weights and mixed bones", () => {
    expect(rigidBoneIndex([1, 2, 0, 0], [0.5, 0.5, 0, 0], 4)).toBeUndefined();
    expect(rigidBoneIndex([1, 0, 0, 0, 2, 0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0], 4)).toBeUndefined();
  });
});

describe("mergeDrawGroups", () => {
  test("merges contiguous same-material ranges and keeps material changes", () => {
    expect(mergeDrawGroups([
      { start: 0, count: 6, materialIndex: 0 },
      { start: 6, count: 6, materialIndex: 0 },
      { start: 12, count: 6, materialIndex: 1 },
      { start: 18, count: 6, materialIndex: 0 },
    ])).toEqual([
      { start: 0, count: 12, materialIndex: 0 },
      { start: 12, count: 6, materialIndex: 1 },
      { start: 18, count: 6, materialIndex: 0 },
    ]);
  });
});
