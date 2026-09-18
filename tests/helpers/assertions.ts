/**
 * Runtime assertions shared by unit tests.
 *
 * Tests previously reached optional fixture state with non-null assertions
 * (`undo.before!`, `groups.find(...)!`). A `!` silences the compiler without
 * checking anything, so a regression surfaces later as an opaque
 * `TypeError: undefined is not an object`. These helpers check at runtime and
 * fail with a message that names the missing value.
 *
 * @module
 */

/**
 * Narrows `value` to a non-null object whose string keys can be read.
 *
 * Tool results, parsed parameters, and bundled fixture exports arrive as
 * `unknown`; this guard is the single structural check performed before their
 * properties are read. Plain objects, arrays, and class instances pass;
 * `null`, primitives, and functions do not.
 *
 * @param value - Any value to inspect.
 * @returns `true` when `value` is a non-null object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Returns `value` when it is present, otherwise throws an error naming it.
 *
 * Replaces non-null assertions in tests so a missing fixture value fails at the
 * point of access with a readable message. Falsy but present values (`0`, `""`,
 * `false`) are returned unchanged.
 *
 * @example
 * const carrier = required(HostGroup.all.find((group) => group.name === "Carrier"), "Carrier group");
 *
 * @param value - The possibly missing value.
 * @param label - Human-readable name used in the failure message, e.g. `"last undo entry"`.
 * @returns `value`, narrowed to exclude `null` and `undefined`.
 * @throws {TypeError} When `value` is `null` or `undefined`; the message names `label` and which nullish value was received.
 */
export function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new TypeError(`Expected ${label} to be present, but it was ${String(value)}.`);
  }
  return value;
}
