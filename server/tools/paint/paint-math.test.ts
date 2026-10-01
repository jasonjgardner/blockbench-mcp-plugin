import { describe, expect, test } from "bun:test";
import {
  alphaToOpacity,
  brushPresetAliases,
  fromOpacityRange,
  matchesBrushPreset,
  normalizeHexColor,
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

describe("normalizeHexColor", () => {
  test.each([
    ["#F00", "#ff0000"],
    ["#0a8", "#00aa88"],
    ["12AbEf", "#12abef"],
    [" #00FF00 ", "#00ff00"],
    // Alpha parts are dropped, as before: the color panel keeps no alpha.
    ["#F008", "#ff0000"],
    ["#FF000080", "#ff0000"],
  ])("%p becomes %p", (input, expected) => {
    expect(normalizeHexColor(input)).toBe(expected);
  });

  test.each(["red", "rgb(255, 0, 0)", "#12345"])("%p is left for the color panel to parse", input => {
    expect(normalizeHexColor(input)).toBe(input);
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
