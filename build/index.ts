import { build } from "bun";
import { watch } from "node:fs";
import { mkdir, access, copyFile, rename, rmdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, normalize, sep } from "node:path";
import { argv } from "node:process";
import { log, c, isCleanMode, isProduction, isWatchMode } from "./utils";
import { blockbenchCompatPlugin, textFileLoaderPlugin } from "./plugins";

const OUTPUT_DIR = "./dist";
// Normalized output dir name for path comparison (strips "./" prefix)
const OUTPUT_DIR_NAME = normalize(OUTPUT_DIR).replace(/^\.[\\/]/, "");
const entryFile = resolve("./index.ts");

async function cleanOutputDir() {
  try {
    await access(OUTPUT_DIR);
    log.header("[Build] Clean");
    log.step(`Cleaning output directory: ${c.cyan}${OUTPUT_DIR}${c.reset}`);
    await rmdir(OUTPUT_DIR, { recursive: true });
  } catch {
    // Directory doesn't exist, no need to clean
    log.dim("[Build] Output directory does not exist, no need to clean.");
  }
}

// Function to handle the build process
async function buildPlugin(): Promise<boolean> {
  // Ensure output directory exists
  try {
    await mkdir(OUTPUT_DIR, { recursive: true });
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code !== "EEXIST") {
      log.header(`${c.red}[Build] Error${c.reset}`);
      log.error(`Error creating output directory: ${error}`);
      return false;
    }
  }

  // Build the plugin
  const result = await build({
    entrypoints: [entryFile],
    outdir: OUTPUT_DIR,
    target: "node",
    format: "cjs",
    sourcemap: argv.includes("--sourcemap") ? "external" : "none",
    plugins: [blockbenchCompatPlugin, textFileLoaderPlugin],
    external: [
      "three",
      "tinycolor2",
      // Native modules that require permission in Blockbench v5.0+
      "node:module",
      "node:fs",
      "node:fs/promises",
      "node:child_process",
      "node:https",
      "node:net",
      "node:tls",
      "node:util",
      "node:os",
      "node:v8",
      "child_process",
      "http",
      "https",
      "net",
      "tls",
      "util",
      "os",
      "v8",
    ],
    minify: isProduction
      ? {
          whitespace: true,
          syntax: true,
          identifiers: true,
        }
      : false,
    // Compile-time constants for dead code elimination
    define: {
      "process.env.NODE_ENV": isProduction ? '"production"' : '"development"',
      __DEV__: isProduction ? "false" : "true",
    },
    // Remove debugger statements in production
    drop: isProduction ? ["debugger"] : [],
  });

  if (!result.success) {
    log.header(`${c.red}[Build] Failed${c.reset}`);
    for (const message of result.logs) {
      log.error(String(message));
    }
    return false;
  }

  log.header("[Build] Assets");

  const iconSource = resolve("./icon.svg");
  const iconDest = join(OUTPUT_DIR, "icon.svg");

  try {
    // Check if icon exists and copy it
    await access(iconSource);
    await copyFile(iconSource, iconDest);
    log.step(`Copied ${c.cyan}icon.svg${c.reset}`);
  } catch {
    // File doesn't exist or couldn't be copied, just continue
  }

  const indexFile = join(OUTPUT_DIR, "index.js");
  const mcpFile = join(OUTPUT_DIR, "mcp.js");

  try {
    // Check if index file exists and rename it
    await access(indexFile);
    await rename(indexFile, mcpFile);
    log.step(`Renamed ${c.gray}index.js${c.reset} → ${c.cyan}mcp.js${c.reset}`);
  } catch {
    // File doesn't exist or couldn't be renamed
  }

  try {
    const mcpContent = await readFile(mcpFile, "utf-8");
    const banner = "let process = requireNativeModule('process');\n";

    if (!mcpContent.startsWith(banner)) {
      await writeFile(mcpFile, banner + mcpContent, "utf-8");
    }
  } catch (error) {
    // If the bundle doesn't exist or can't be edited, just continue.
  }

  // Rename the sourcemap file
  const indexMapFile = join(OUTPUT_DIR, "index.js.map");
  const mcpMapFile = join(OUTPUT_DIR, "mcp.js.map");

  try {
    // Check if map file exists and rename it
    await access(indexMapFile);
    await rename(indexMapFile, mcpMapFile);
    log.step(`Renamed ${c.gray}index.js.map${c.reset} → ${c.cyan}mcp.js.map${c.reset}`);
  } catch {
    // File doesn't exist or couldn't be renamed
  }

  // Copy the README file
  const readmeSource = resolve("./about.md");
  const readmeDest = join(OUTPUT_DIR, "about.md");

  try {
    await access(readmeSource);
    await copyFile(readmeSource, readmeDest);
    log.step(`Copied ${c.cyan}about.md${c.reset}`);
  } catch {
    // File doesn't exist or couldn't be copied
  }

  return true;
}

// Function to watch for file changes
function watchFiles() {
  log.info("[Build] Watching for changes...");

  // Build serialization to prevent overlapping builds
  let currentBuild: Promise<void> | null = null;
  let pendingRebuild = false;

  async function queueRebuild(filename: string) {
    // If a build is in progress, mark as pending and return
    if (currentBuild) {
      pendingRebuild = true;
      return;
    }

    // Start the build
    currentBuild = (async () => {
      do {
        pendingRebuild = false;
        log.header(`${c.yellow}[Build] Rebuild${c.reset}`);
        log.step(`File changed: ${c.cyan}${filename}${c.reset}`);
        await cleanOutputDir();
        await buildPlugin();
        log.success("Rebuild complete");
      } while (pendingRebuild);
    })();

    try {
      await currentBuild;
    } finally {
      currentBuild = null;
    }
  }

  const watcher = watch(
    "./",
    { recursive: true },
    (_eventType, filename) => {
      if (!filename) return;

      // Normalize filename for consistent comparison
      const normalizedFilename = normalize(filename);

      // Ignore output directory (compare normalized paths)
      if (
        normalizedFilename === OUTPUT_DIR_NAME ||
        normalizedFilename.startsWith(`${OUTPUT_DIR_NAME}${sep}`)
      ) {
        return;
      }

      // Ignore other non-source files
      if (
        normalizedFilename.endsWith(".js.map") ||
        normalizedFilename.includes(".git") ||
        normalizedFilename.startsWith(`node_modules${sep}`) ||
        normalizedFilename === "node_modules"
      ) {
        return;
      }

      queueRebuild(filename);
    }
  );

  // Handle process termination
  process.on("SIGINT", () => {
    watcher.close();
    log.dim("[Build] Watch mode stopped");
    process.exit(0);
  });
}

async function main() {
  log.header("[Build] MCP Plugin");

  if (isCleanMode) {
    await cleanOutputDir();
  }

  if (isWatchMode) {
    log.info("Building with watch mode...");
    const success = await buildPlugin();
    if (success) {
      log.success(`Initial build completed. Output in ${c.cyan}${OUTPUT_DIR}${c.reset}`);
      watchFiles();
    }
  } else {
    log.info("Building...");
    const success = await buildPlugin();
    if (success) {
      log.success(`Build completed. Output in ${c.cyan}${OUTPUT_DIR}${c.reset}`);
    }
    if (!success) {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  log.header(`${c.red}[Build] Fatal Error${c.reset}`);
  log.error(String(err));
  process.exit(1);
});
