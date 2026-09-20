import { expect, test } from "bun:test";
import {
  GECKOLIB_EASING_DEFAULT,
  GECKOLIB_EASING_NAMES,
  getEasingArgDefault,
  getEasingArgDescription,
  isArgsEasing,
  isGeckolibEasing,
  normalizeEasingArgs,
  reverseEasing,
} from "./geckolib-easing";

test("exposes linear, step and every family in all three directions", () => {
  expect(GECKOLIB_EASING_NAMES.slice(0, 2)).toEqual([GECKOLIB_EASING_DEFAULT, "step"]);
  // linear + step + 10 families x 3 directions.
  expect(GECKOLIB_EASING_NAMES).toHaveLength(32);
  expect(new Set(GECKOLIB_EASING_NAMES).size).toBe(GECKOLIB_EASING_NAMES.length);
  ["easeInQuad", "easeOutSine", "easeInOutElastic", "easeOutBounce", "easeInBack", "easeInOutCirc"].forEach((easing) => {
    expect(isGeckolibEasing(easing)).toBe(true);
  });
});

test("rejects names GeckoLib would silently treat as linear", () => {
  ["easeInSmooth", "ease", "EaseInQuad", "bezier", "catmullrom", ""].forEach((easing) => {
    expect(isGeckolibEasing(easing)).toBe(false);
  });
});

test("only Back, Elastic, Bounce and step read arguments", () => {
  const withArgs = GECKOLIB_EASING_NAMES.filter(isArgsEasing);
  // 3 directions each of Back, Elastic and Bounce, plus step.
  expect(withArgs).toHaveLength(10);
  expect(withArgs).toContain("step");
  expect(isArgsEasing("easeInOutQuint")).toBe(false);
  expect(isArgsEasing()).toBe(false);
});

test.each([
  ["step", 5],
  ["easeInBack", 1],
  ["easeInOutElastic", 1],
  ["easeOutBounce", 0.5],
])("%s defaults its first argument to %p", (easing, expected) => {
  expect(getEasingArgDefault(easing)).toBe(expected);
  expect(getEasingArgDescription(easing)).toBeString();
});

test("argument-free easings report no default and no description", () => {
  expect(getEasingArgDefault("easeInCubic")).toBeNull();
  expect(getEasingArgDefault(GECKOLIB_EASING_DEFAULT)).toBeNull();
  expect(getEasingArgDescription("easeInCubic")).toBeNull();
});

test("normalizing fills the plugin default and drops arguments that would never be read", () => {
  expect(normalizeEasingArgs("easeOutBack")).toEqual([1]);
  expect(normalizeEasingArgs("easeOutBounce", [])).toEqual([0.5]);
  expect(normalizeEasingArgs("easeOutBack", [2.5])).toEqual([2.5]);
  // A stray easingArgs array makes GeckoLib drop the whole animation.
  expect(normalizeEasingArgs("easeInQuad", [3])).toBeUndefined();
  expect(normalizeEasingArgs("linear")).toBeUndefined();
});

test("step counts are floored and must stay above GeckoLib's stepRange minimum", () => {
  expect(normalizeEasingArgs("step", [7.9])).toEqual([7]);
  expect(normalizeEasingArgs("step", [2])).toEqual([2]);
  expect(() => normalizeEasingArgs("step", [1])).toThrow("at least 2 steps");
  expect(() => normalizeEasingArgs("step", [0.5])).toThrow("at least 2 steps");
});

test.each([[Infinity], [NaN], [-Infinity]])("rejects the non-finite argument %p", (value) => {
  expect(() => normalizeEasingArgs("easeInElastic", [value])).toThrow("finite numbers");
});

test("reversing mirrors direction and leaves symmetric easings alone", () => {
  expect(reverseEasing("easeInQuad")).toBe("easeOutQuad");
  expect(reverseEasing("easeOutBounce")).toBe("easeInBounce");
  expect(reverseEasing("easeInOutCubic")).toBe("easeInOutCubic");
  expect(reverseEasing("step")).toBe("step");
  expect(reverseEasing("linear")).toBe("linear");
  expect(reverseEasing(undefined)).toBeUndefined();
});

test("every reversed name is itself a GeckoLib easing", () => {
  GECKOLIB_EASING_NAMES.forEach((easing) => {
    expect(isGeckolibEasing(reverseEasing(easing) as string)).toBe(true);
  });
});
