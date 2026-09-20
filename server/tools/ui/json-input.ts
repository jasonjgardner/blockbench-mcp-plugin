/// <reference types="blockbench-types" />
import type { FormResultValue } from "blockbench-types/generated/interface/form";

/**
 * `MouseEventInit` members that JSON can express as booleans: event flags and
 * modifier keys. `view` and `relatedTarget` are omitted because JSON cannot
 * produce a `Window` or `EventTarget`.
 */
const BOOLEAN_EVENT_INIT_KEYS = [
  "bubbles",
  "cancelable",
  "composed",
  "altKey",
  "ctrlKey",
  "metaKey",
  "shiftKey",
  "modifierAltGraph",
  "modifierCapsLock",
  "modifierFn",
  "modifierFnLock",
  "modifierHyper",
  "modifierNumLock",
  "modifierScrollLock",
  "modifierSuper",
  "modifierSymbol",
  "modifierSymbolLock",
] as const satisfies readonly (keyof MouseEventInit)[];

/** `MouseEventInit` members that JSON can express as numbers: pointer coordinates, buttons, and click detail. */
const NUMBER_EVENT_INIT_KEYS = [
  "button",
  "buttons",
  "clientX",
  "clientY",
  "movementX",
  "movementY",
  "screenX",
  "screenY",
  "detail",
  "which",
] as const satisfies readonly (keyof MouseEventInit)[];

/** JSON value kinds that Blockbench accepts as a form field value (`FormResultValue`). */
const FORM_VALUE_TYPES = new Set(["string", "number", "boolean", "object"]);

/**
 * Parses a JSON tool argument that must encode a plain object.
 *
 * Tool schemas accept these options as strings so MCP clients can pass
 * free-form host options; the object shape is checked here before use.
 *
 * @param value - Raw JSON text supplied by the MCP client.
 * @param name - Argument name used in error messages (for example `confirmEvent`).
 * @returns The parsed object with unknown member values, ready for narrowing.
 * @throws When `value` is not valid JSON, or when it encodes `null`, an array, or a primitive.
 */
export function parseObjectJSON(value: string, name: string): Record<string, unknown> {
  const parsed = parseJSON(value, name);
  if (!isPlainRecord(parsed)) throw new Error(`${name} must be a JSON object.`);
  return parsed;
}

/**
 * Narrows `confirmEvent` options into a `MouseEventInit`.
 *
 * Only known boolean and numeric init members are forwarded, so arbitrary
 * JSON never reaches the native `MouseEvent` constructor. Members the
 * constructor would ignore (unknown keys) are dropped as before.
 *
 * @param options - Parsed `confirmEvent` members, excluding the `event` type.
 * @returns Init options containing only correctly typed known members.
 * @throws When a known member has the wrong type, such as `{"shiftKey": "yes"}`.
 */
export function toMouseEventInit(options: Record<string, unknown>): MouseEventInit {
  return {
    ...pickEventInit(options, BOOLEAN_EVENT_INIT_KEYS, isBoolean, "a boolean"),
    ...pickEventInit(options, NUMBER_EVENT_INIT_KEYS, isFiniteNumber, "a finite number"),
  };
}

/**
 * Narrows parsed dialog values into Blockbench form values.
 *
 * Every JSON value except `null` is a valid `FormResultValue`. Null members are
 * omitted because Blockbench's `Form.setValues` already skips nullish values,
 * so the dialog is left unchanged for those fields exactly as before.
 *
 * @param values - Parsed `fill_dialog` values keyed by form field ID.
 * @returns Values safe to pass to `Dialog#setFormValues`.
 */
export function toFormValues(values: Record<string, unknown>): Record<string, FormResultValue> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, FormResultValue] => isFormResultValue(entry[1]))
  );
}

/** Parses JSON, rethrowing syntax errors with the argument name and original cause. */
function parseJSON(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** True for non-null, non-array objects. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for boolean values. */
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** True for finite numbers; JSON overflow such as `1e999` parses to Infinity and is rejected. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** True for JSON values Blockbench can store in a form field. */
function isFormResultValue(value: unknown): value is FormResultValue {
  return value !== null && FORM_VALUE_TYPES.has(typeof value);
}

/** Copies present `keys` from `options`, throwing when a present value fails `isValid`. */
function pickEventInit<K extends keyof MouseEventInit, V>(
  options: Record<string, unknown>,
  keys: readonly K[],
  isValid: (value: unknown) => value is V,
  expected: string,
): Partial<Record<K, V>> {
  return keys
    .filter((key) => Object.hasOwn(options, key))
    .reduce<Partial<Record<K, V>>>((init, key) => {
      const value = options[key];
      if (!isValid(value)) throw new Error(`confirmEvent.${key} must be ${expected}.`);
      return { ...init, [key]: value };
    }, {});
}
