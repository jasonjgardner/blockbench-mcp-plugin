/**
 * GeckoLib keyframe easing metadata.
 *
 * GeckoLib extends Blockbench keyframes with an `easing` name and an optional
 * `easingArgs` array that Blockbench itself has no concept of: the plugin
 * monkeypatches `Keyframe.prototype.getLerp`/`compileBedrockKeyframe` so the
 * eased value is both previewed and written into the exported animation JSON.
 * Nothing in the native keyframe API can author these, which is why the MCP
 * tools need their own description of the easing set.
 *
 * Names, argument-taking easings, and argument defaults mirror the GeckoLib
 * Blockbench plugin (MIT, `src/ts/easing.ts`, plugin 4.2.x). Keep this module
 * free of Blockbench globals so the docs generator can import it.
 *
 * @module
 */

/** Easing applied when a keyframe carries no explicit easing. */
export const GECKOLIB_EASING_DEFAULT = "linear";

/** Easing families that are generated for each direction. */
const DIRECTIONAL_EASING_FAMILIES = [
  "Quad",
  "Cubic",
  "Quart",
  "Quint",
  "Sine",
  "Expo",
  "Circ",
  "Back",
  "Elastic",
  "Bounce",
] as const;

/** Direction prefixes GeckoLib exposes for every easing family. */
const EASING_DIRECTIONS = ["easeIn", "easeOut", "easeInOut"] as const;

/**
 * Every easing name GeckoLib accepts, in the plugin's own order: `linear`,
 * `step`, then each family in easeIn/easeOut/easeInOut order.
 */
export const GECKOLIB_EASING_NAMES: readonly string[] = Object.freeze([
  GECKOLIB_EASING_DEFAULT,
  "step",
  ...DIRECTIONAL_EASING_FAMILIES.flatMap((family) =>
    EASING_DIRECTIONS.map((direction) => `${direction}${family}`)
  ),
]);

/**
 * Whether `easing` is one of the names GeckoLib resolves. Unknown names are
 * silently treated as linear by the GeckoLib runtime, so tools reject them
 * instead of writing a value that quietly does nothing.
 */
export function isGeckolibEasing(easing: string): boolean {
  return GECKOLIB_EASING_NAMES.includes(easing);
}

/**
 * Whether an easing reads `easingArgs`. The Back, Elastic, and Bounce families
 * take a shape argument and `step` takes a step count; every other easing
 * ignores arguments entirely.
 */
export function isArgsEasing(easing = ""): boolean {
  return (
    easing.includes("Back") ||
    easing.includes("Elastic") ||
    easing.includes("Bounce") ||
    easing === "step"
  );
}

/**
 * Default first `easingArgs` value the GeckoLib plugin fills in for an
 * argument-taking easing.
 *
 * @returns Overshoot 1 for Back/Elastic, bounciness 0.5 for Bounce, 5 steps for
 *   `step`, or `null` for easings that take no argument.
 */
export function getEasingArgDefault(easing: string): number | null {
  if (easing === "step") return 5;
  if (easing.includes("Back") || easing.includes("Elastic")) return 1;
  if (easing.includes("Bounce")) return 0.5;
  return null;
}

/** Human-readable meaning of an argument-taking easing's first argument. */
export function getEasingArgDescription(easing: string): string | null {
  if (easing === "step") return "Number of discrete steps; integers of at least 2.";
  if (easing.includes("Back")) return "Overshoot scalar applied to GeckoLib's 1.70158 back constant.";
  if (easing.includes("Elastic")) return "Elastic bounciness; higher values oscillate more.";
  if (easing.includes("Bounce")) return "Bounce bounciness; higher values bounce more.";
  return null;
}

/**
 * Normalizes an agent-supplied argument list for `easing`.
 *
 * `step` is floored to an integer, as the plugin's own input parsing does, but
 * a count below 2 is rejected rather than clamped up to 2 the way the plugin's
 * text field does. GeckoLib's `stepRange` throws below 2, and clamping would
 * silently change the animation's timing where an API caller cannot see it,
 * whereas an error tells the caller exactly what to send instead.
 * Easings that take no argument normalize to `undefined` so no stray
 * `easingArgs` reaches the exported JSON, where a malformed array makes
 * GeckoLib drop the whole animation.
 *
 * @param easing - Easing the arguments belong to.
 * @param args - Requested arguments, or `undefined` to use the plugin default.
 * @returns The arguments to store, or `undefined` to store none.
 * @throws When a value is not finite, or a `step` count is below 2.
 */
export function normalizeEasingArgs(easing: string, args?: readonly number[]): number[] | undefined {
  if (!isArgsEasing(easing)) return undefined;
  const requested = args?.length ? args : [getEasingArgDefault(easing) as number];
  if (requested.some((value) => !Number.isFinite(value))) {
    throw new Error(`Easing arguments for "${easing}" must be finite numbers.`);
  }
  if (easing !== "step") return [...requested];
  const steps = Math.floor(requested[0]);
  if (steps < 2) {
    throw new Error(`The "step" easing needs at least 2 steps; received ${requested[0]}.`);
  }
  return [steps];
}

/**
 * Mirrors an easing's direction, as GeckoLib's own "reverse keyframes" handler
 * does. `easeInOut*` easings and `linear`/`step` are already symmetric and are
 * returned unchanged.
 */
export function reverseEasing(easing?: string): string | undefined {
  if (!easing || easing.startsWith("easeInOut")) return easing;
  if (easing.startsWith("easeIn")) return easing.replace("easeIn", "easeOut");
  if (easing.startsWith("easeOut")) return easing.replace("easeOut", "easeIn");
  return easing;
}
