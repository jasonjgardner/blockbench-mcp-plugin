/**
 * Save and restore Blockbench host globals on `globalThis`.
 *
 * Tool modules read Blockbench runtime globals (`Project`, `Undo`, `Mesh`, ...)
 * directly, so unit tests install host doubles on `globalThis`. Bun runs every
 * test file in one process, so each file must put back exactly what it found —
 * including keys that were absent (which must be deleted, not set to
 * `undefined`) and accessor properties (whose getter/setter identity must
 * survive). These helpers capture full property descriptors to do that.
 *
 * @module
 */

import { afterEach, beforeEach } from "bun:test";

/**
 * Restores every global captured by {@link snapshotGlobals} or {@link installGlobals}.
 *
 * Restores all keys even when some fail, then throws an `AggregateError` listing
 * the failures. Calling it more than once re-applies the same original state.
 */
export type RestoreGlobals = () => void;

/** Global values keyed by global name, e.g. `{ Project: project, Undo: undoHost }`. */
export type GlobalValues = Readonly<Record<string, unknown>>;

interface ISavedGlobal {
  readonly key: string;
  /** `undefined` records that the key was absent and must be deleted on restore. */
  readonly descriptor: PropertyDescriptor | undefined;
}

/**
 * Captures the current property descriptors of `keys` on `globalThis`.
 *
 * Use directly for the "snapshot once in `beforeAll`, restore in `afterAll`"
 * style, or when a test assigns globals itself (e.g. `Object.assign(globalThis, { Preview })`).
 *
 * @param keys - Global names to capture; duplicates are ignored.
 * @returns A function that restores each key's original descriptor, deleting keys that were absent.
 */
export function snapshotGlobals(keys: Iterable<string>): RestoreGlobals {
  const saved: readonly ISavedGlobal[] = [...new Set(keys)].map((key) => ({
    descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
    key,
  }));
  return () => {
    const failures = saved.toReversed().flatMap(tryRestoreGlobal);
    if (failures.length > 0) throw new AggregateError(failures, "Some globals could not be restored.");
  };
}

/**
 * Installs `values` as configurable, writable globals and returns their restore function.
 *
 * Works from either hook style: call it in `beforeEach` and invoke the result in
 * `afterEach`, or call it once in `beforeAll` and restore in `afterAll`.
 * Installation is atomic — if any key cannot be defined, keys installed so far
 * are restored before the error is rethrown.
 *
 * @param values - Globals to install, keyed by name.
 * @param additionalKeys - Extra globals to capture without installing, for keys a test assigns later
 *   (e.g. `["Preview", "window"]`), so they are also restored.
 * @returns A function restoring every captured key to its pre-install descriptor.
 * @throws {TypeError} When an existing global is non-configurable; `cause` holds the engine error.
 */
export function installGlobals(values: GlobalValues, additionalKeys: Iterable<string> = []): RestoreGlobals {
  const restore = snapshotGlobals([...Object.keys(values), ...additionalKeys]);
  try {
    Object.entries(values).forEach(([key, value]) => defineGlobal(key, value));
    return restore;
  } catch (error) {
    return rethrowAfterRestore(error, restore);
  }
}

/**
 * Registers `beforeEach`/`afterEach` hooks that install fresh globals for every test.
 *
 * Hooks run in registration order in Bun, so register this AFTER any `beforeEach`
 * that resets state the factory reads (such as `project = {...}`), and AFTER any
 * `afterEach` that still needs the globals (such as a teardown calling `Blockbench.removeListener`).
 *
 * @param factory - Builds the globals for one test; called in `beforeEach` so each test gets fresh values.
 * @param additionalKeys - Globals the tests assign themselves that must also be restored after each test.
 */
export function useGlobals(factory: () => GlobalValues, additionalKeys: readonly string[] = []): void {
  let restore: RestoreGlobals | undefined;
  beforeEach(() => {
    restore = installGlobals(factory(), additionalKeys);
  });
  afterEach(() => {
    const current = restore;
    restore = undefined;
    current?.();
  });
}

function defineGlobal(key: string, value: unknown): void {
  try {
    Object.defineProperty(globalThis, key, { configurable: true, enumerable: true, value, writable: true });
  } catch (error) {
    throw new TypeError(`Cannot install global "${key}"; the existing property is not configurable.`, { cause: error });
  }
}

function tryRestoreGlobal({ key, descriptor }: ISavedGlobal): unknown[] {
  try {
    restoreGlobal(key, descriptor);
    return [];
  } catch (error) {
    return [error];
  }
}

function restoreGlobal(key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }
  if (!Reflect.deleteProperty(globalThis, key)) {
    throw new TypeError(`Cannot remove global "${key}"; it was redefined as non-configurable.`);
  }
}

function rethrowAfterRestore(error: unknown, restore: RestoreGlobals): never {
  try {
    restore();
  } catch (restoreError) {
    throw new AggregateError([error, restoreError], "Installing globals failed and the previous globals could not be restored.");
  }
  throw error;
}
