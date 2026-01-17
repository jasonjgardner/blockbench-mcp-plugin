import { build, type BunPlugin } from "bun";
import { watch } from "node:fs";
import { mkdir, access, copyFile, rename, rmdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { argv } from "node:process";

const OUTPUT_DIR = "./dist";
const entryFile = path.resolve("./index.ts");
const isWatchMode = argv.includes("--watch");
const isCleanMode = argv.includes("--clean");

async function fetchIcon() {
  try {
    const iconPath = path.resolve("./icon.svg");
    const content = await readFile(iconPath, "utf8");
    // Base64 encode the SVG content
    return `"data:image/svg+xml;base64,${Buffer.from(content).toString("base64")}"`;
  } catch {
    return `"icon.svg"`;
  }
}

/**
 * Bun plugin to replace restricted Node modules with Blockbench-compatible versions
 * Uses requireNativeModule() to avoid permission prompts in Blockbench v5.0+
 */
const blockbenchCompatPlugin: BunPlugin = {
  name: "blockbench-compat",
  setup(build) {
    build.onResolve({ filter: /^process$/ }, (args) => {
      return { path: args.path, namespace: "blockbench-compat" };
    });

    build.onLoad({ filter: /^process$/, namespace: "blockbench-compat" }, () => {
      return {
        contents: `module.exports = typeof requireNativeModule !== 'undefined' ? requireNativeModule('process') : require('process');`,
        loader: "js",
      };
    });

    // Handle 'fs' imports
    build.onResolve({ filter: /^fs$/ }, (args) => {
      return { path: args.path, namespace: "blockbench-compat" };
    });

    build.onLoad({ filter: /^fs$/, namespace: "blockbench-compat" }, () => {
      return {
        contents: `module.exports = typeof requireNativeModule !== 'undefined' ? requireNativeModule('fs') : require('fs');`,
        loader: "js",
      };
    });

    // Handle 'fs/promises' imports
    build.onResolve({ filter: /^fs\/promises$/ }, (args) => {
      return { path: args.path, namespace: "blockbench-compat" };
    });

    build.onLoad({ filter: /^fs\/promises$/, namespace: "blockbench-compat" }, () => {
      return {
        contents: `const fs = typeof requireNativeModule !== 'undefined' ? requireNativeModule('fs') : require('fs'); module.exports = fs.promises;`,
        loader: "js",
      };
    });

    // Handle 'path' imports
    build.onResolve({ filter: /^path$/ }, (args) => {
      return { path: args.path, namespace: "blockbench-compat" };
    });

    build.onLoad({ filter: /^path$/, namespace: "blockbench-compat" }, () => {
      return {
        contents: `module.exports = typeof requireNativeModule !== 'undefined' ? requireNativeModule('path') : require('path');`,
        loader: "js",
      };
    });

    // Handle '@hono/node-server' - provide a minimal shim
    // The MCP SDK uses getRequestListener to convert Node.js HTTP to Web Standard
    build.onResolve({ filter: /^@hono\/node-server$/ }, (args) => {
      return { path: args.path, namespace: "blockbench-compat" };
    });

    build.onLoad({ filter: /^@hono\/node-server$/, namespace: "blockbench-compat" }, () => {
      return {
        contents: `
// Minimal @hono/node-server shim for Blockbench
// Converts Node.js HTTP IncomingMessage/ServerResponse to Web Standard Request/Response

function getRequestListener(handler) {
  return async function(req, res) {
    try {
      // Build URL from request
      const protocol = req.socket?.encrypted ? 'https' : 'http';
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url || '/', protocol + '://' + host);

      // Convert headers
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          if (Array.isArray(value)) {
            value.forEach(v => headers.append(key, v));
          } else {
            headers.set(key, value);
          }
        }
      }

      // Build request init
      const init = { method: req.method, headers };

      // Add body for non-GET/HEAD requests
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // If body was already parsed, use it
        if (req.body !== undefined) {
          init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        }
      }

      // Create Web Standard Request
      const webRequest = new Request(url.toString(), init);

      // Call handler and get Web Standard Response
      const webResponse = await handler(webRequest);

      // Convert Web Standard Response back to Node.js response
      res.statusCode = webResponse.status;
      webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      // Send body
      if (webResponse.body) {
        const reader = webResponse.body.getReader();
        const pump = async () => {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            return;
          }
          res.write(value);
          await pump();
        };
        await pump();
      } else {
        const text = await webResponse.text();
        res.end(text);
      }
    } catch (error) {
      console.error('[MCP] Request handler error:', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error) }));
      }
    }
  };
}

export { getRequestListener };
        `,
        loader: "js",
      };
    });
  },
};

async function cleanOutputDir() {
  try {
    await access(OUTPUT_DIR);
    console.group("[Build] Clean");
    console.log(`Cleaning output directory: ${OUTPUT_DIR}`);
    await rmdir(OUTPUT_DIR, { recursive: true });
    console.groupEnd();
  } catch (error) {
    // Directory doesn't exist, no need to clean
    console.log(`[Build] Output directory does not exist, no need to clean.`);
  }
}

// Function to handle the build process
async function buildPlugin(): Promise<boolean> {
  // Ensure output directory exists
  try {
    await mkdir(OUTPUT_DIR, { recursive: true });
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code !== "EEXIST") {
      console.group("[Build] Error");
      console.error("Error creating output directory:", error);
      console.groupEnd();
      return false;
    }
  }

  const isProduction = process.env.NODE_ENV === "production" || argv.includes("--minify");

  // Build the plugin
  const result = await build({
    entrypoints: [entryFile],
    outdir: OUTPUT_DIR,
    target: "node",
    format: "cjs",
    sourcemap: argv.includes("--sourcemap") ? "external" : "none",
    plugins: [blockbenchCompatPlugin],
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
      __ICON__: await fetchIcon(),
    },
    // Remove debugger statements in production
    drop: isProduction ? ["debugger"] : [],
  });

  if (!result.success) {
    console.group("[Build] Failed");
    for (const message of result.logs) {
      console.error(message);
    }
    console.groupEnd();
    return false;
  }

  console.group("[Build] Assets");

  const iconSource = path.resolve("./icon.svg");
  const iconDest = path.join(OUTPUT_DIR, "icon.svg");

  try {
    // Check if icon exists and copy it
    await access(iconSource);
    await copyFile(iconSource, iconDest);
    console.log("Copied icon.svg");
  } catch (error) {
    // File doesn't exist or couldn't be copied, just continue
  }

  const indexFile = path.join(OUTPUT_DIR, "index.js");
  const mcpFile = path.join(OUTPUT_DIR, "mcp.js");

  try {
    // Check if index file exists and rename it
    await access(indexFile);
    await rename(indexFile, mcpFile);
    console.log("Renamed index.js to mcp.js");
  } catch (error) {
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
  const indexMapFile = path.join(OUTPUT_DIR, "index.js.map");
  const mcpMapFile = path.join(OUTPUT_DIR, "mcp.js.map");

  try {
    // Check if map file exists and rename it
    await access(indexMapFile);
    await rename(indexMapFile, mcpMapFile);
    console.log("Renamed index.js.map to mcp.js.map");
  } catch (error) {
    // File doesn't exist or couldn't be renamed
  }

  // Copy the README file
  const readmeSource = path.resolve("./about.md");
  const readmeDest = path.join(OUTPUT_DIR, "about.md");

  try {
    await access(readmeSource);
    await copyFile(readmeSource, readmeDest);
    console.log("Copied about.md");
  } catch (error) {
    // File doesn't exist or couldn't be copied
  }

  console.groupEnd();

  return true;
}

// Function to watch for file changes
function watchFiles() {
  console.log("[Build] Watching for changes...");

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

      console.group("[Build] Rebuild");
      console.log(`File changed: ${filename}`);
      await cleanOutputDir();
      await buildPlugin();
      console.log("Rebuild complete");
      console.groupEnd();
    }
  );

  // Handle process termination
  process.on("SIGINT", () => {
    watcher.close();
    console.log("[Build] Watch mode stopped");
    process.exit(0);
  });
}

async function main() {
  console.group("[Build] MCP Plugin");

  if (isCleanMode) {
    await cleanOutputDir();
  }

  if (isWatchMode) {
    console.log("Building with watch mode...");
    const success = await buildPlugin();
    if (success) {
      console.log(`Initial build completed. Output in ${OUTPUT_DIR}`);
      console.groupEnd();
      watchFiles();
    } else {
      console.groupEnd();
    }
  } else {
    console.log("Building...");
    const success = await buildPlugin();
    if (success) {
      console.log(`Build completed. Output in ${OUTPUT_DIR}`);
    }
    console.groupEnd();
    if (!success) {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.group("[Build] Fatal Error");
  console.error(err);
  console.groupEnd();
  process.exit(1);
});
