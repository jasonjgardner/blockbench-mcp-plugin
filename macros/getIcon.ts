import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { minifySVG } from "../build/utils";

/**
 * Bun macro that reads icon.svg, minifies it, and returns as a base64 data URL.
 * Executes at build time - the result is embedded directly into the bundle.
 */
export function getIcon(): string {
  const iconPath = resolve(import.meta.dir, "..", "icon.svg");
  const svg = readFileSync(iconPath, "utf-8");
  const minified = minifySVG(svg);
  const base64 = Buffer.from(minified).toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
}
