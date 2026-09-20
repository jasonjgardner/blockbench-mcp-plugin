import { describe, expect, test } from "bun:test";
import { PLAYHEAD_EPSILON, filterFramesByPlayhead } from "./playhead";

const frames = [0, 0.5, 1, 1 + PLAYHEAD_EPSILON / 2, 1.5, 2].map((time, index) => ({ id: index, time }));

describe("filterFramesByPlayhead", () => {
  test("before includes frames on the playhead within the native 1e-5 tolerance", () => {
    expect(filterFramesByPlayhead(frames, 1, "before").map(({ id }) => id)).toEqual([0, 1, 2, 3]);
  });

  test("after includes frames on the playhead within the native 1e-5 tolerance", () => {
    expect(filterFramesByPlayhead(frames, 1, "after").map(({ id }) => id)).toEqual([2, 3, 4, 5]);
  });

  test("frames just outside the tolerance are excluded", () => {
    const edge = [{ time: 1 + 2 * PLAYHEAD_EPSILON }, { time: 1 - 2 * PLAYHEAD_EPSILON }];
    expect(filterFramesByPlayhead(edge, 1, "before")).toEqual([{ time: 1 - 2 * PLAYHEAD_EPSILON }]);
    expect(filterFramesByPlayhead(edge, 1, "after")).toEqual([{ time: 1 + 2 * PLAYHEAD_EPSILON }]);
  });

  test("returns a new array and preserves input order", () => {
    const unordered = [{ time: 3 }, { time: 0 }, { time: 2 }];
    const result = filterFramesByPlayhead(unordered, 5, "before");
    expect(result).toEqual(unordered);
    expect(result).not.toBe(unordered);
  });
});
