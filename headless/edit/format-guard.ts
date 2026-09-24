/**
 * Keeps edits inside what the model's Blockbench format can hold.
 *
 * Blockbench refuses, in its UI, what a format cannot represent: meshes outside
 * the Generic (`free`) format, Java block cubes with multi-axis or off-grid
 * rotations, cubes past the block bounds, and so on. A headless batch would
 * otherwise save such a file silently, and the desktop app or the game would
 * later drop or mangle it. The guard checks only the nodes a batch added or
 * changed, so an older file that already breaks a rule never locks every edit.
 *
 * @module
 */

import type { IBBModel } from "../document/schema";
import { checkElements, type IFormatViolation } from "../formats/rules";

/** Outcome of a guard check: errors reject the batch, warnings are reported. */
export interface IFormatGuardResult {
  errors: IFormatViolation[];
  warnings: IFormatViolation[];
}

/** UUIDs of elements and groups that are new in `after` or differ from `before`. */
export function touchedNodes(before: IBBModel, after: IBBModel): string[] {
  const previous = new Map<string, string>([...before.elements, ...before.groups].map((node) => [node.uuid, JSON.stringify(node)]));
  return [...after.elements, ...after.groups].filter((node) => previous.get(node.uuid) !== JSON.stringify(node)).map((node) => node.uuid);
}

/**
 * Checks the nodes a batch touched against the model's format.
 *
 * @returns Errors (the caller must refuse the write) and warnings (to report).
 */
export function checkFormat(before: IBBModel, after: IBBModel): IFormatGuardResult {
  const touched = touchedNodes(before, after);
  if (touched.length === 0) return { errors: [], warnings: [] };
  const violations = checkElements(after, touched);
  return { errors: violations.filter((v) => v.severity === "error"), warnings: violations.filter((v) => v.severity !== "error") };
}

/**
 * Throws when a batch breaks the format's rules; otherwise returns warning messages.
 *
 * @throws Error listing every violation and how to fix it.
 */
export function enforceFormat(before: IBBModel, after: IBBModel): string[] {
  const { errors, warnings } = checkFormat(before, after);
  if (errors.length > 0) {
    const format = after.meta.model_format;
    throw new Error(`The ${format} format cannot hold this edit (nothing was written):\n${errors.map((v) => `- ${v.name}: ${v.message}`).join("\n")}`);
  }
  return warnings.map((v) => `${v.name}: ${v.message}`);
}
