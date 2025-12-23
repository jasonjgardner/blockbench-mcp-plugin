import { build, type BunPlugin } from "bun";
import { watch } from "node:fs";
import { mkdir, access, copyFile, rename, rmdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { argv } from "node:process";

const OUTPUT_DIR = "./dist";
const entryFile = path.resolve("./index.ts");
const isWatchMode = argv.includes("--watch");
const isCleanMode = argv.includes("--clean");

/**
 * Bun plugin to replace restricted Node modules with Blockbench-compatible versions
 * Uses requireNativeModule() to avoid permission prompts in Blockbench v5.0+
 */
const blockbenchCompatPlugin: BunPlugin = {
  name: "blockbench-compat",
  setup(build) {
    // Intercept node:module imports - mark as external
    build.onResolve({ filter: /^node:module$/ }, () => {
      return { path: "node:module", external: true };
    });
  },
};

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
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code !== "EEXIST") {
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
    plugins: [blockbenchCompatPlugin],
    external: [
      "three",
      "tinycolor2",
      // Official MCP SDK (will be required at runtime)
      // "@modelcontextprotocol/sdk",
      // "@modelcontextprotocol/sdk/server/mcp.js",
      // "@modelcontextprotocol/sdk/server/streamableHttp.js",
      // Express for HTTP server
      // "express",
      // Prevent undici from bundling and requiring restricted native modules
      "undici",
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
      "fs",
      "fs/promises",
      "child_process",
      "http",
      "https",
      "net",
      "tls",
      "util",
      "os",
      "v8",
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

  // Inject Blockbench-compatible require shims at the top of the bundle
  try {
    const mcpContent = await readFile(mcpFile, "utf-8");

    const shims = `// Blockbench v5.0+ compatible module shims
// Uses requireNativeModule() API for proper permission handling
(function() {
  // Provide minimal process shim for Blockbench
  // Note: For full process module, use requireNativeModule('process')
  if (typeof process === 'undefined') {
    globalThis.process = {
      env: {},
      version: 'blockbench',
      versions: {},
      platform: typeof SystemInfo !== 'undefined' ? SystemInfo.platform : 'unknown',
      arch: typeof SystemInfo !== 'undefined' ? SystemInfo.arch : 'unknown',
      argv: [],
      cwd: function() { return ''; },
      nextTick: function(cb) { setTimeout(cb, 0); },
      on: function() { return this; },
      once: function() { return this; },
      off: function() { return this; },
      emit: function() { return false; },
      removeListener: function() { return this; },
      browser: true
    };
  }

  // Cache original require
  var originalRequire = typeof require !== 'undefined' ? require : function() { throw new Error('require is not defined'); };

  // Module cache for lazy loading (keyed by module id + options hash)
  var moduleCache = {};

  // Requestable modules that require user permission in Blockbench v5.0+
  // Reference: https://github.com/JannisX11/blockbench/blob/master/js/native_apis.ts
  var REQUESTABLE_APIS = ['fs', 'process', 'child_process', 'https', 'net', 'tls', 'util', 'os', 'v8', 'dialog'];

  // Shim for node:module
  var moduleShim = {
    createRequire: function() { return require; },
    builtinModules: [],
    isBuiltin: function() { return false; }
  };

  // Helper to get cache key for module with options
  function getCacheKey(id, options) {
    if (!options || !options.scope) {
      return id;
    }
    return id + ':' + options.scope;
  }

  // Helper to get or create cached module using requireNativeModule
  // Supports options: { scope, message, optional, show_permission_dialog }
  function getCachedModule(id, options) {
    var cacheKey = getCacheKey(id, options);

    if (moduleCache[cacheKey]) {
      return moduleCache[cacheKey];
    }

    if (typeof requireNativeModule !== 'undefined') {
      try {
        var result = requireNativeModule(id, options);
        if (result) {
          moduleCache[cacheKey] = result;
        }
        return result;
      } catch (e) {
        console.error('Failed to load native module ' + id + ':', e);
        return undefined;
      }
    }

    return undefined;
  }

  // Create shimmed require function that uses requireNativeModule for restricted APIs
  var shimmedRequire = function(id, options) {
    // Normalize module id (strip node: prefix)
    var normalizedId = id.replace(/^node:/, '');

    // Handle shimmed modules
    if (normalizedId === 'module') return moduleShim;

    // Handle fs modules - requires scope option for scoped access
    if (normalizedId === 'fs') {
      return getCachedModule('fs', options);
    }
    if (normalizedId === 'fs/promises') {
      var fs = getCachedModule('fs', options);
      return fs ? fs.promises : undefined;
    }

    // Handle process module via requireNativeModule
    if (normalizedId === 'process') {
      var processModule = getCachedModule('process', options);
      // Fall back to global process shim if not available
      return processModule || globalThis.process;
    }

    // Handle child_process module
    if (normalizedId === 'child_process') {
      return getCachedModule('child_process', options);
    }

    // Handle os module via requireNativeModule
    if (normalizedId === 'os') {
      return getCachedModule('os', options);
    }

    // Handle util module via requireNativeModule
    if (normalizedId === 'util') {
      return getCachedModule('util', options);
    }

    // Handle v8 module via requireNativeModule
    if (normalizedId === 'v8') {
      return getCachedModule('v8', options);
    }

    // Handle dialog module (Blockbench-specific)
    if (normalizedId === 'dialog') {
      return getCachedModule('dialog', options);
    }

    // Handle http module (stub - only https is available in Blockbench)
    if (normalizedId === 'http') {
      return {
        METHODS: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
        STATUS_CODES: {},
        Agent: function() {},
        ClientRequest: function() {},
        IncomingMessage: function() {},
        ServerResponse: function() {},
        Server: function() { return { listen: function() { return this; }, on: function() { return this; } }; },
        createServer: function() {
          return {
            listen: function() { return this; },
            on: function() { return this; },
            close: function() {}
          };
        },
        request: function() {},
        get: function() {}
      };
    }

    // Handle https module via requireNativeModule
    if (normalizedId === 'https') {
      return getCachedModule('https', options);
    }

    // Handle net module via requireNativeModule
    if (normalizedId === 'net') {
      return getCachedModule('net', options);
    }

    // Handle tls module via requireNativeModule
    if (normalizedId === 'tls') {
      return getCachedModule('tls', options);
    }

    // Handle tty (return stub - not available in Blockbench)
    if (normalizedId === 'tty') {
      return {
        isatty: function() { return false; },
        ReadStream: function() {},
        WriteStream: function() {}
      };
    }

    // Handle path module - available as PathModule global
    if (normalizedId === 'path') {
      return typeof PathModule !== 'undefined' ? PathModule : originalRequire('path');
    }

    // Handle safe modules that don't require permission
    var safeModules = ['crypto', 'events', 'zlib', 'timers', 'url', 'string_decoder', 'querystring', 'buffer', 'stream', 'assert'];
    if (safeModules.indexOf(normalizedId) !== -1) {
      return originalRequire.call(this, id);
    }

    // Fall through to original require for other modules
    return originalRequire.apply(this, arguments);
  };

  // Copy all properties from original require
  for (var key in originalRequire) {
    if (originalRequire.hasOwnProperty(key)) {
      shimmedRequire[key] = originalRequire[key];
    }
  }

  // Override global require
  if (typeof require !== 'undefined') {
    require = shimmedRequire;
  }

  // Also try to override module.require if available
  if (typeof module !== 'undefined' && module.require) {
    module.require = shimmedRequire;
  }

  // Expose helper for direct requireNativeModule access with options
  globalThis.__bbRequireNative = function(id, options) {
    return getCachedModule(id, options);
  };
})();

`;
    
    await writeFile(mcpFile, shims + mcpContent, "utf-8");
    console.log("✨ Injected Blockbench compatibility shims");
  } catch (error: unknown) {
    console.error("⚠️ Failed to inject shims:", error);
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
