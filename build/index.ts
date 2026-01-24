import { build, type BunPlugin } from "bun";
import { watch } from "node:fs";
import { mkdir, access, copyFile, rename, rmdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { argv } from "node:process";
import { minifyHTML, minifyCSS, log, c } from "./utils";

const OUTPUT_DIR = "./dist";
const entryFile = resolve("./index.ts");
const isWatchMode = argv.includes("--watch");
const isCleanMode = argv.includes("--clean");
const isProduction = process.env.NODE_ENV === "production" || argv.includes("--minify");

/**
 * Bun plugin to import HTML and CSS files as strings
 * Applies minification in production builds
 */
const textFileLoaderPlugin: BunPlugin = {
  name: "text-file-loader",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const content = await Bun.file(args.path).text();
      const processed = isProduction ? minifyCSS(content) : content;
      return {
        contents: `export default ${JSON.stringify(processed)};`,
        loader: "js",
      };
    });

    build.onLoad({ filter: /\.html$/ }, async (args) => {
      const content = await Bun.file(args.path).text();
      const processed = isProduction ? minifyHTML(content) : content;
      return {
        contents: `export default ${JSON.stringify(processed)};`,
        loader: "js",
      };
    });
  },
};

async function fetchIcon() {
  try {
    const iconPath = resolve("./icon.svg");
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
      __ICON__: await fetchIcon(),
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

  const watcher = watch(
    "./",
    { recursive: true },
    async (_eventType, filename) => {
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

      log.header(`${c.yellow}[Build] Rebuild${c.reset}`);
      log.step(`File changed: ${c.cyan}${filename}${c.reset}`);
      await cleanOutputDir();
      await buildPlugin();
      log.success("Rebuild complete");
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
