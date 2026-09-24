import { describe, expect, test } from "bun:test";

import { mergeOptions, PRESETS, resolveCameraAngles, resolveOptions } from "./options";

describe("render options", () => {
  test("applies defaults", () => {
    const options = resolveOptions({ input: "a.bbmodel", output: "b.png" });
    expect(options).toMatchObject({ width: 1920, height: 1080, supersample: 2, toneMapping: "agx" });
    expect(options.camera).toMatchObject({ view: "three-quarter", fov: 30, orthographic: false });
    expect(options.animation).toEqual({ start: 0 });
  });

  test("lists every invalid field at once", () => {
    expect(() => resolveOptions({ input: "a", output: "b.png", width: 4, camera: { view: "sideways" as never }, background: "red" })).toThrow(
      /background[\s\S]*width[\s\S]*camera\.view/,
    );
  });

  test("presets layer under flags and unset flags never erase them", () => {
    const merged = mergeOptions(PRESETS.icon as Record<string, unknown>, { width: undefined, camera: { view: "front", orthographic: undefined } });
    const options = resolveOptions({ ...(merged as object), input: "a", output: "b.png" });
    expect(options.width).toBe(512);
    expect(options.background).toBe("transparent");
    expect(options.camera).toMatchObject({ view: "front", orthographic: true });
  });

  test("an explicit azimuth overrides the named view", () => {
    const options = resolveOptions({ input: "a", output: "b.png", camera: { view: "right", azimuth: 12 } });
    expect(resolveCameraAngles(options.camera)).toEqual({ azimuth: 12, elevation: 8 });
  });
});
