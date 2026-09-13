/**
 * Runtime narrowing for untrusted MCP tool responses and exported project JSON.
 * Live smoke scripts read data produced by a running Blockbench instance, so every
 * shape is verified here instead of being asserted with `as` casts.
 */

/**
 * Type guard for plain JSON objects (not arrays, not null).
 *
 * @param value - Any parsed JSON value.
 * @returns True when `value` can be read as `Record<string, unknown>`.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows a value to a plain object or fails the smoke run.
 *
 * @param value - Untrusted value, e.g. a tool response field.
 * @param context - Human-readable name used in the failure message.
 * @returns The same value typed as `Record<string, unknown>`.
 * @throws When `value` is not a plain object.
 */
export function record(value: unknown, context = "value"): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected ${context} to be an object`);
  return value;
}

/**
 * Narrows a value to an array of plain objects, e.g. exported `elements` or MCP content blocks.
 *
 * @param value - Untrusted value.
 * @param context - Human-readable name used in failure messages.
 * @returns The same items typed as `Record<string, unknown>[]`.
 * @throws When `value` is not an array or any item is not a plain object.
 */
export function records(value: unknown, context = "value"): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${context} to be an array`);
  return value.map((item: unknown, index) => record(item, `${context}[${index}]`));
}

/**
 * Narrows a value to a string array, e.g. mesh vertex or face keys.
 *
 * @param value - Untrusted value.
 * @param context - Human-readable name used in the failure message.
 * @returns The same array typed as `string[]`.
 * @throws When `value` is not an array or contains a non-string item.
 */
export function strings(value: unknown, context = "value"): string[] {
  return arrayOf(value, (item): item is string => typeof item === "string", `${context} to be an array of strings`);
}

/**
 * Narrows a value to a number array, e.g. a vertex position or face normal.
 *
 * @param value - Untrusted value.
 * @param context - Human-readable name used in the failure message.
 * @returns The same array typed as `number[]`.
 * @throws When `value` is not an array or contains a non-number item.
 */
export function numbers(value: unknown, context = "value"): number[] {
  return arrayOf(value, (item): item is number => typeof item === "number", `${context} to be an array of numbers`);
}

/** Narrows `value` to `T[]` when it is an array whose every item satisfies `isItem`. */
function arrayOf<T>(value: unknown, isItem: (item: unknown) => item is T, expectation: string): T[] {
  if (!Array.isArray(value) || !value.every(isItem)) throw new Error(`Expected ${expectation}`);
  return value;
}

/**
 * Returns a deep copy whose object keys are sorted, so structurally equal JSON
 * values serialize identically regardless of property insertion order.
 *
 * @param value - Any JSON-compatible value.
 * @returns Arrays keep their order; objects are rebuilt with sorted keys.
 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

/**
 * Compares two JSON values while ignoring object key order.
 *
 * @param left - First value.
 * @param right - Second value.
 * @returns True when both canonical serializations are identical.
 */
export function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/**
 * Parses JSON text that must describe an object, keeping the parser error as the cause.
 *
 * @param text - Raw JSON text, e.g. a tool's text content block or exported `.bbmodel`.
 * @param context - Human-readable source name used in failure messages.
 * @returns The parsed object.
 * @throws When the text is not valid JSON or does not describe a plain object.
 */
export function parseJsonRecord(text: string, context: string): Record<string, unknown> {
  try {
    return record(JSON.parse(text), context);
  } catch (error: unknown) {
    throw new Error(`${context} is not a valid JSON object`, { cause: error });
  }
}
