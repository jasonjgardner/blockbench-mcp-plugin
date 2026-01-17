import { readFileSync } from "fs";
import path from "path";

function minifyHTML(html: string): string {
  return html
    // Remove HTML comments (but not Vue conditional comments)
    .replace(/<!--(?!\[)[\s\S]*?-->/g, "")
    // Collapse whitespace between tags
    .replace(/>\s+</g, "><")
    // Collapse multiple spaces/newlines into single space within text
    .replace(/\s+/g, " ")
    // Remove spaces around equals in attributes
    .replace(/\s*=\s*/g, "=")
    // Trim leading/trailing whitespace
    .trim();
}

export default function importHTML(relativePath: string): string {
  const absolutePath = path.resolve(import.meta.dir, "..", relativePath);
  const content = readFileSync(absolutePath, "utf-8");
  return minifyHTML(content);
}
