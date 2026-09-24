import { describe, expect, test } from "bun:test";

import { HD_MIN_PIXELS, HD_TEXELS_PER_UV_UNIT, wantsSmooth } from "./texture-filter";

describe("wantsSmooth", () => {
  test("auto keeps Blockbench pixel art crisp and smooths HD atlases", () => {
    expect(wantsSmooth("auto", { pixels: 32, texelsPerUvUnit: 1 })).toBe(false);
    expect(wantsSmooth("auto", { pixels: 64, texelsPerUvUnit: 2 })).toBe(false);
    expect(wantsSmooth("auto", { pixels: 2048, texelsPerUvUnit: 128 })).toBe(true);
    expect(wantsSmooth("auto", { pixels: 64, texelsPerUvUnit: HD_TEXELS_PER_UV_UNIT })).toBe(true);
  });

  test("auto uses image size for glTF and USD textures without UV density", () => {
    expect(wantsSmooth("auto", { pixels: 16 })).toBe(false);
    expect(wantsSmooth("auto", { pixels: HD_MIN_PIXELS })).toBe(true);
  });

  test("explicit modes override the heuristic", () => {
    expect(wantsSmooth("nearest", { pixels: 4096, texelsPerUvUnit: 256 })).toBe(false);
    expect(wantsSmooth("smooth", { pixels: 16, texelsPerUvUnit: 1 })).toBe(true);
  });
});
