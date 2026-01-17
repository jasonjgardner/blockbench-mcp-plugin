import { readFileSync } from "node:fs";
import path from "node:path";

function minifyCSS(css: string): string {
  return css
    // Remove comments
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Remove whitespace around specific characters
    .replace(/\s*([{}:;,>~+])\s*/g, "$1")
    // Collapse multiple spaces/newlines into single space
    .replace(/\s+/g, " ")
    // Remove spaces around selectors
    .replace(/\s*([()])\s*/g, "$1")
    // Remove trailing semicolons before closing braces
    .replace(/;}/g, "}")
    // Trim
    .trim();
}

export default function importStylesheet(relativePath: string): string {
  const absolutePath = path.resolve(import.meta.dir, "..", relativePath);
  const content = readFileSync(absolutePath, "utf-8");
  return minifyCSS(content);
}
