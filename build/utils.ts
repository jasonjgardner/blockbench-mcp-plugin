import { argv } from "node:process";
/**
 * ANSI color codes for console output
 */
export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

export const log = {
  info: (msg: string) => console.log(`${c.cyan}${msg}${c.reset}`),
  success: (msg: string) => console.log(`${c.green}${msg}${c.reset}`),
  warn: (msg: string) => console.log(`${c.yellow}${msg}${c.reset}`),
  error: (msg: string) => console.error(`${c.red}${msg}${c.reset}`),
  dim: (msg: string) => console.log(`${c.dim}${msg}${c.reset}`),
  step: (msg: string) => console.log(`  ${c.gray}→${c.reset} ${msg}`),
  header: (msg: string) => console.log(`\n${c.bold}${c.blue}${msg}${c.reset}`),
};

/**
 * Minify CSS by removing comments and unnecessary whitespace
 */
export function minifyCSS(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s*([{}:;,>~+])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s*([()])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

/**
 * Minify HTML by removing comments and collapsing whitespace
 */
export function minifyHTML(html: string): string {
  return html
    .replace(/<!--(?!\[)[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .replace(/\s*=\s*/g, "=")
    .trim();
}

/**
 * Minify SVG by removing comments, XML declarations, and unnecessary whitespace
 */
export function minifySVG(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*\?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .replace(/\s*=\s*/g, "=")
    .replace(/\s+\/>/g, "/>")
    .trim();
}

const isWatchMode = argv.includes("--watch");
const isCleanMode = argv.includes("--clean");
const isProduction = process.env.NODE_ENV === "production" || argv.includes("--minify");

export { isWatchMode, isCleanMode, isProduction };