import { watch } from "node:fs";
import { mkdir, copyFile, rename, rmdir } from "node:fs/promises";
import { resolve, join, normalize, sep } from "node:path";
import { log, c, isCleanMode, isProduction, isWatchMode } from "./utils";
import { blockbenchCompatPlugin, textFileLoaderPlugin } from "./plugins";

const OUTPUT_DIR = "./dist";
// Normalized output dir name for path comparison (strips "./" prefix)
const OUTPUT_DIR_NAME = normalize(OUTPUT_DIR).replace(/^\.[\\/]/, "");
const entryFile = resolve("./index.ts");

async function cleanOutputDir() {
  const dirExists = await Bun.file(OUTPUT_DIR).exists();
  if (dirExists) {
    log.header("[Build] Clean");
    log.step(`Cleaning output directory: ${c.cyan}${OUTPUT_DIR}${c.reset}`);
    await rmdir(OUTPUT_DIR, { recursive: true });
  } else {
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
  const result = await Bun.build({
    entrypoints: [entryFile],
    outdir: OUTPUT_DIR,
    target: "node",
    format: "cjs",
    sourcemap: Bun.argv.includes("--sourcemap") ? "external" : "none",
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

  if (await Bun.file(iconSource).exists()) {
    await copyFile(iconSource, iconDest);
    log.step(`Copied ${c.cyan}icon.svg${c.reset}`);
  }

  const indexFile = join(OUTPUT_DIR, "index.js");
  const mcpFile = join(OUTPUT_DIR, "mcp.js");

  if (await Bun.file(indexFile).exists()) {
    await rename(indexFile, mcpFile);
    log.step(`Renamed ${c.gray}index.js${c.reset} → ${c.cyan}mcp.js${c.reset}`);
  }

  const mcpBunFile = Bun.file(mcpFile);
  if (await mcpBunFile.exists()) {
    const mcpContent = await mcpBunFile.text();
    const banner = "let process = requireNativeModule('process');\n";

    if (!mcpContent.startsWith(banner)) {
      await Bun.write(mcpFile, banner + mcpContent);
    }
  }

  // Rename the sourcemap file
  const indexMapFile = join(OUTPUT_DIR, "index.js.map");
  const mcpMapFile = join(OUTPUT_DIR, "mcp.js.map");

  if (await Bun.file(indexMapFile).exists()) {
    await rename(indexMapFile, mcpMapFile);
    log.step(`Renamed ${c.gray}index.js.map${c.reset} → ${c.cyan}mcp.js.map${c.reset}`);
  }

  // Copy the README file
  const readmeSource = resolve("./about.md");
  const readmeDest = join(OUTPUT_DIR, "about.md");

  if (await Bun.file(readmeSource).exists()) {
    await copyFile(readmeSource, readmeDest);
    log.step(`Copied ${c.cyan}about.md${c.reset}`);
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
