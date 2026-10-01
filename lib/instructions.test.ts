import { expect, test } from "bun:test";
import { LEGACY_DEFAULT_INSTRUCTIONS, effectiveInstructions } from "./instructions";

test("the pre-1.10 default is treated as unset", () => {
  expect(effectiveInstructions(LEGACY_DEFAULT_INSTRUCTIONS)).toBe("");
  expect(effectiveInstructions(`  ${LEGACY_DEFAULT_INSTRUCTIONS}\n`)).toBe("");
});

test("custom instructions are sent trimmed", () => {
  expect(effectiveInstructions("  Build Hytale props.  ")).toBe("Build Hytale props.");
});

test("blank and non-string values send nothing", () => {
  for (const value of ["", "   ", undefined, null, 42]) {
    expect(effectiveInstructions(value)).toBe("");
  }
});
