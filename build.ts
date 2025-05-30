import { build } from "bun";
import { watch } from "node:fs";
import { mkdir, access, copyFile, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import { argv } from "node:process";

const OUTPUT_DIR = "./dist";
const entryFile = path.resolve("./index.ts");
const isWatchMode = argv.includes("--watch");
const isCleanMode = argv.includes("--clean");

async function cleanOutputDir() {
  try {
    await access(OUTPUT_DIR);
    console.log(`🗑️ Cleaning output directory: ${OUTPUT_DIR}`);
    await rmdir(OUTPUT_DIR, { recursive: true });
  } catch (error) {
    // Directory doesn't exist, no need to clean
    console.log(`🗑️ Output directory does not exist, no need to clean.`);
  }
}

// Function to handle the build process
async function buildPlugin(): Promise<boolean> {
  // Ensure output directory exists
  try {
    await mkdir(OUTPUT_DIR, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") {
      console.error("Error creating output directory:", error);
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
    external: [
      //   "express",
      //     "zod",
      //     "@modelcontextprotocol/*"
    ],
    minify: process.env.NODE_ENV === "production" || argv.includes("--minify"),
  });

  if (!result.success) {
    console.error("❌ Build failed:");
    for (const message of result.logs) {
      console.error(message);
    }
    return false;
  }

  const iconSource = path.resolve("./icon.svg");
  const iconDest = path.join(OUTPUT_DIR, "icon.svg");

  try {
    // Check if icon exists and copy it
    await access(iconSource);
    await copyFile(iconSource, iconDest);
    console.log("📁 Copied icon.svg");
  } catch (error) {
    // File doesn't exist or couldn't be copied, just continue
  }

  const indexFile = path.join(OUTPUT_DIR, "index.js");
  const mcpFile = path.join(OUTPUT_DIR, "mcp.js");

  try {
    // Check if index file exists and rename it
    await access(indexFile);
    await rename(indexFile, mcpFile);
    console.log("📁 Renamed index.js to mcp.js");
  } catch (error) {
    // File doesn't exist or couldn't be renamed
  }

  // Rename the sourcemap file
  const indexMapFile = path.join(OUTPUT_DIR, "index.js.map");
  const mcpMapFile = path.join(OUTPUT_DIR, "mcp.js.map");

  try {
    // Check if map file exists and rename it
    await access(indexMapFile);
    await rename(indexMapFile, mcpMapFile);
    console.log("📁 Renamed index.js.map to mcp.js.map");
  } catch (error) {
    // File doesn't exist or couldn't be renamed
  }

  // Copy the README file
  const readmeSource = path.resolve("./about.md");
  const readmeDest = path.join(OUTPUT_DIR, "about.md");

  try {
    await access(readmeSource);
    await copyFile(readmeSource, readmeDest);
    console.log("📁 Copied about.md");
  } catch (error) {
    // File doesn't exist or couldn't be copied
  }

  return true;
}

// Function to watch for file changes
function watchFiles() {
  console.log("👀 Watching for changes...");

  const watcher = watch(
    "./",
    { recursive: true },
    async (eventType, filename) => {
      if (!filename) return;

      // Ignore self, output directory and some file types
      if (
        filename.includes(OUTPUT_DIR) ||
        filename.endsWith(".js.map") ||
        filename.endsWith(".git") ||
        filename === "node_modules" ||
        filename === __filename
      ) {
        return;
      }

      console.log(`📄 File changed: ${filename}. Rebuilding...`);
      await cleanOutputDir();
      await buildPlugin();
      console.log("✅ Rebuild complete! Watching for more changes...");
    }
  );

  // Handle process termination
  process.on("SIGINT", () => {
    watcher.close();
    console.log("\n🛑 Watch mode stopped");
    process.exit(0);
  });
}

async function main() {
  if (isCleanMode) {
    console.log("🗑️ Cleaning output directory...");
    await cleanOutputDir();
    console.log("✅ Cleaned output directory!");
  }
  
  if (isWatchMode) {
    console.log("🏗️ Building MCP plugin with Bun (watch mode)...");
    const success = await buildPlugin();
    if (success) {
      console.log(
        `✅ Initial build completed successfully! Output in ${OUTPUT_DIR}`
      );
      watchFiles();
    }
  } else {
    console.log("🏗️ Building MCP plugin with Bun...");
    const success = await buildPlugin();
    if (success) {
      console.log(`✅ Build completed successfully! Output in ${OUTPUT_DIR}`);
    } else {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("💥 Build error:", err);
  process.exit(1);
});
