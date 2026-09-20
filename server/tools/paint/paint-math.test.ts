import { describe, expect, test } from "bun:test";
import {
  alphaToOpacity,
  brushDimensions,
  brushPresetAliases,
  fromOpacityRange,
  matchesBrushPreset,
  parseOpacityRange,
  shortBrushPresetName,
  toOpacityRange,
} from "./paint-math";

describe("opacity range conversion", () => {
  test.each([
    ["255", 255],
    ["100", 100],
    [100, 100],
    [undefined, 255],
    ["garbage", 255],
  ] as const)("parseOpacityRange(%p) is %p", (value, expected) => {
    expect(parseOpacityRange(value)).toBe(expected);
  });

  test.each([
    [0, 255, 0],
    [128, 255, 128],
    [255, 255, 255],
    [0, 100, 0],
    [255, 100, 100],
    [128, 100, 50.2],
    [51, 100, 20],
  ] as const)("toOpacityRange(%p, %p) is %p", (opacity, range, expected) => {
    expect(toOpacityRange(opacity, range)).toBe(expected);
  });

  test("toOpacityRange clamps out-of-range input", () => {
    expect(toOpacityRange(-10, 100)).toBe(0);
    expect(toOpacityRange(999, 255)).toBe(255);
  });

  test.each([255, 100] as const)("fromOpacityRange inverts toOpacityRange for range %p", range => {
    [0, 1, 64, 128, 200, 255].forEach(opacity => {
      expect(fromOpacityRange(toOpacityRange(opacity, range), range)).toBe(opacity);
    });
  });

  test("alphaToOpacity follows Blockbench's floor(alpha * 256) capped at 255", () => {
    expect(alphaToOpacity(0)).toBe(0);
    expect(alphaToOpacity(0.5)).toBe(128);
    expect(alphaToOpacity(1)).toBe(255);
  });
});

describe("brushDimensions", () => {
  test("zero aspect ratio keeps the brush even", () => {
    expect(brushDimensions(8, 0)).toEqual([8, 8]);
  });

  test("negative aspect ratio narrows the width, positive the height", () => {
    expect(brushDimensions(9, -2)).toEqual([3, 9]);
    expect(brushDimensions(9, 2)).toEqual([9, 3]);
  });
});

describe("brush preset names", () => {
  test("built-in keys match their short name, full key and translated label", () => {
    const aliases = brushPresetAliases("menu.brush_presets.screen_space", "Screen Space Brush");
    expect(matchesBrushPreset("screen_space", aliases)).toBe(true);
    expect(matchesBrushPreset("menu.brush_presets.screen_space", aliases)).toBe(true);
    expect(matchesBrushPreset(" screen space brush ", aliases)).toBe(true);
    expect(matchesBrushPreset("smooth_brush", aliases)).toBe(false);
  });

  test("custom names are kept as-is", () => {
    expect(shortBrushPresetName("My Brush")).toBe("My Brush");
    expect(shortBrushPresetName("menu.brush_presets.pixel_brush")).toBe("pixel_brush");
  });
});
