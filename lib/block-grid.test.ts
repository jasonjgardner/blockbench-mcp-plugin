import { describe, expect, test } from "bun:test";
import {
  blockCellName,
  blockCellOf,
  blockCellOrigin,
  checkBlockBounds,
  cubeExtents,
  planGridCuts,
  unionExtents,
} from "./block-grid";

const limits = { maxSize: 30, maxCenterOffset: 7, cellSize: 16 };

describe("planGridCuts", () => {
  test("vertical cuts fall on multiples of the cell size strictly inside the span", () => {
    expect(planGridCuts(6, 64, 1)).toEqual([16, 32, 48]);
    expect(planGridCuts(0, 16, 1)).toEqual([]);
    expect(planGridCuts(0, 7.4, 1)).toEqual([]);
  });

  test("horizontal cuts are centered on the block, so boundaries sit at ±8, ±24", () => {
    expect(planGridCuts(-14.8, 14.8, 0)).toEqual([-8, 8]);
    expect(planGridCuts(18, 42, 2)).toEqual([24, 40]);
  });

  test("boundaries within the edge tolerance are skipped and inverted spans are accepted", () => {
    expect(planGridCuts(15.5, 40, 1)).toEqual([32]);
    expect(planGridCuts(40, 6, 1)).toEqual([16, 32]);
  });
});

describe("block cells", () => {
  test("cells round horizontally, floor vertically, and never produce negative zero", () => {
    expect(blockCellOf([0, 8, 0])).toEqual([0, 0, 0]);
    expect(blockCellOf([-9, 20, 9])).toEqual([-1, 1, 1]);
    expect(blockCellOf([-1, 17, -1])).toEqual([0, 1, 0]);
    expect(Object.is(blockCellOf([-1, 17, -1])[0], -0)).toBe(false);
  });

  test("cell names follow Blockbench's multiblock scheme", () => {
    expect(blockCellName([0, 0, 0])).toBe("bottom");
    expect(blockCellName([0, 1, 0])).toBe("top");
    expect(blockCellName([1, 1, -1])).toBe("right_top_back");
    expect(blockCellName([0, 3, 0])).toBe("top3");
    expect(blockCellName([-2, -1, 0])).toBe("left2_below");
    expect(blockCellOrigin([1, 2, -1])).toEqual([16, 32, -16]);
  });
});

describe("checkBlockBounds", () => {
  test("a 30×30×30 box centered on the block is valid, and so is one shifted by the full 7 units", () => {
    expect(checkBlockBounds({ min: [-15, -7, -15], max: [15, 23, 15] }, limits)).toMatchObject({ within_size_limit: true, within_center_offset: true, valid: true });
    expect(checkBlockBounds({ min: [-22, -14, -22], max: [8, 16, 8] }, limits)).toMatchObject({ valid: true });
    expect(checkBlockBounds({ min: [-15, 0, -15], max: [15, 30, 15] }, limits)).toMatchObject({ valid: true });
  });

  test("matches Blockbench's limiter: a legal offset section passes, a 23-unit reach fails", () => {
    expect(checkBlockBounds({ min: [12, 1, -5], max: [22, 11, 5] }, limits)).toMatchObject({ valid: true });
    expect(checkBlockBounds({ min: [-7, 1, -7], max: [23, 15, 7] }, limits)).toMatchObject({
      within_size_limit: true, within_center_offset: false, valid: false,
    });
    expect(checkBlockBounds({ min: [-2.8, 6, 27.2], max: [2.8, 64, 32.8] }, limits)).toMatchObject({
      within_size_limit: false, within_center_offset: false, valid: false,
    });
  });

  test("extents include inflate and union across cubes", () => {
    const box = cubeExtents([4, 2, 3], [0, 6, 1], 0.5);
    expect(box).toEqual({ min: [-0.5, 1.5, 0.5], max: [4.5, 6.5, 3.5] });
    expect(unionExtents([box, { min: [-3, 0, 0], max: [1, 1, 9] }])).toEqual({ min: [-3, 0, 0], max: [4.5, 6.5, 9] });
    expect(unionExtents([])).toBeUndefined();
  });
});
