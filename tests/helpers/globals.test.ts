import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { installGlobals, snapshotGlobals, useGlobals } from "./globals";

// Unique names keep these tests from touching globals other test files rely on.
const ABSENT = "__helpersGlobalsAbsent";
const PRESENT = "__helpersGlobalsPresent";
const ACCESSOR = "__helpersGlobalsAccessor";
const EXTRA = "__helpersGlobalsExtra";
// Non-configurable globals cannot be removed, so these two stay defined for the rest of the process.
const LOCKED = "__helpersGlobalsLocked";
const LOCKED_LATER = "__helpersGlobalsLockedLater";
const KEYS = [ABSENT, PRESENT, ACCESSOR, EXTRA];

const presentDescriptor: PropertyDescriptor = { configurable: true, enumerable: false, value: "original", writable: false };
let accessorValue = "getter";
const accessorDescriptor: PropertyDescriptor = {
  configurable: true,
  enumerable: true,
  get: () => accessorValue,
  set: (value: string) => { accessorValue = value; },
};

beforeAll(() => {
  Object.defineProperty(globalThis, LOCKED, { configurable: false, value: "locked", writable: false });
});

afterEach(() => {
  KEYS.forEach((key) => Reflect.deleteProperty(globalThis, key));
});

function captureError(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

function definePresentGlobals(): void {
  Object.defineProperty(globalThis, PRESENT, presentDescriptor);
  Object.defineProperty(globalThis, ACCESSOR, accessorDescriptor);
}

describe("snapshotGlobals", () => {
  test("deletes keys that were absent instead of leaving them undefined", () => {
    const restore = snapshotGlobals([ABSENT]);
    Object.assign(globalThis, { [ABSENT]: "installed" });
    restore();
    expect(Object.hasOwn(globalThis, ABSENT)).toBe(false);
  });

  test("restores data and accessor descriptors exactly, including getter identity", () => {
    definePresentGlobals();
    const restore = snapshotGlobals([PRESENT, ACCESSOR, PRESENT]);
    Object.defineProperty(globalThis, PRESENT, { configurable: true, value: "replaced", writable: true });
    Object.defineProperty(globalThis, ACCESSOR, { configurable: true, value: "shadowed", writable: true });
    restore();
    expect(Object.getOwnPropertyDescriptor(globalThis, PRESENT)).toEqual(presentDescriptor);
    const accessor = Object.getOwnPropertyDescriptor(globalThis, ACCESSOR);
    expect(accessor?.get).toBe(accessorDescriptor.get);
    expect(accessor?.set).toBe(accessorDescriptor.set);
    expect(Reflect.get(globalThis, ACCESSOR)).toBe("getter");
  });

  test("recreates present globals a test deleted", () => {
    definePresentGlobals();
    const restore = snapshotGlobals([PRESENT]);
    Reflect.deleteProperty(globalThis, PRESENT);
    restore();
    expect(Reflect.get(globalThis, PRESENT)).toBe("original");
  });

  test("restores every other key before reporting keys that cannot be restored", () => {
    const restore = snapshotGlobals([LOCKED_LATER, ABSENT]);
    Object.defineProperty(globalThis, LOCKED_LATER, { configurable: false, value: "stuck", writable: false });
    Object.assign(globalThis, { [ABSENT]: "installed" });
    expect(restore).toThrow(AggregateError);
    expect(Object.hasOwn(globalThis, ABSENT)).toBe(false);
  });
});

describe("installGlobals", () => {
  test("installs writable globals and restores them together with additional keys", () => {
    definePresentGlobals();
    const restore = installGlobals({ [ABSENT]: { host: true }, [PRESENT]: "installed" }, [EXTRA]);
    expect(Reflect.get(globalThis, ABSENT)).toEqual({ host: true });
    expect(Reflect.get(globalThis, PRESENT)).toBe("installed");
    Object.assign(globalThis, { [ABSENT]: null, [EXTRA]: "assigned by test" });
    restore();
    expect(Object.hasOwn(globalThis, ABSENT)).toBe(false);
    expect(Object.hasOwn(globalThis, EXTRA)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(globalThis, PRESENT)).toEqual(presentDescriptor);
  });

  test("rolls back earlier keys and preserves the cause when a global is not configurable", () => {
    const install = () => installGlobals({ [ABSENT]: "first", [LOCKED]: "second" });
    expect(install).toThrow(`Cannot install global "${LOCKED}"`);
    expect(Object.hasOwn(globalThis, ABSENT)).toBe(false);
    expect(Reflect.get(globalThis, LOCKED)).toBe("locked");
    const error = captureError(install);
    expect(error).toBeInstanceOf(TypeError);
    expect(error instanceof Error && error.cause).toBeInstanceOf(TypeError);
  });
});

describe("useGlobals", () => {
  let created = 0;
  useGlobals(() => ({ [ABSENT]: { test: ++created } }), [EXTRA]);

  test("installs fresh values before each test", () => {
    expect(Reflect.get(globalThis, ABSENT)).toEqual({ test: 1 });
    Object.assign(globalThis, { [ABSENT]: "mutated", [EXTRA]: "leak" });
  });

  test("restores the previous test's assignments, including additional keys", () => {
    expect(Reflect.get(globalThis, ABSENT)).toEqual({ test: 2 });
    expect(Object.hasOwn(globalThis, EXTRA)).toBe(false);
  });
});

test("useGlobals hooks do not leak outside their describe block", () => {
  expect(Object.hasOwn(globalThis, ABSENT)).toBe(false);
});
