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

  // Inject Blockbench-compatible require shims at the top of the bundle
//   try {
//     const mcpContent = await readFile(mcpFile, "utf-8");

//     const shims = `// Blockbench v5.0+ compatible module shims
// // Uses requireNativeModule() API for proper permission handling
// (function() {
//   // Provide minimal process shim for Blockbench
//   // Note: For full process module, use requireNativeModule('process')
//   if (typeof process === 'undefined') {
//     globalThis.process = {
//       env: {},
//       version: 'blockbench',
//       versions: {},
//       platform: typeof SystemInfo !== 'undefined' ? SystemInfo.platform : 'unknown',
//       arch: typeof SystemInfo !== 'undefined' ? SystemInfo.arch : 'unknown',
//       argv: [],
//       cwd: function() { return ''; },
//       nextTick: function(cb) { setTimeout(cb, 0); },
//       on: function() { return this; },
//       once: function() { return this; },
//       off: function() { return this; },
//       emit: function() { return false; },
//       removeListener: function() { return this; },
//       browser: true
//     };
//   }

//   // Cache original require
//   var originalRequire = typeof require !== 'undefined' ? require : function() { throw new Error('require is not defined'); };

//   // Module cache for lazy loading (keyed by module id + options hash)
//   var moduleCache = {};

//   // Requestable modules that require user permission in Blockbench v5.0+
//   // Reference: https://github.com/JannisX11/blockbench/blob/master/js/native_apis.ts
//   var REQUESTABLE_APIS = ['fs', 'process', 'child_process', 'https', 'net', 'tls', 'util', 'os', 'v8', 'dialog'];

//   // Shim for node:module
//   var moduleShim = {
//     createRequire: function() { return require; },
//     builtinModules: [],
//     isBuiltin: function() { return false; }
//   };

//   // Helper to get cache key for module with options
//   function getCacheKey(id, options) {
//     if (!options || !options.scope) {
//       return id;
//     }
//     return id + ':' + options.scope;
//   }

//   // Helper to get or create cached module using requireNativeModule
//   // Supports options: { scope, message, optional, show_permission_dialog }
//   function getCachedModule(id, options) {
//     var cacheKey = getCacheKey(id, options);

//     if (moduleCache[cacheKey]) {
//       return moduleCache[cacheKey];
//     }

//     if (typeof requireNativeModule !== 'undefined') {
//       try {
//         var result = requireNativeModule(id, options);
//         if (result) {
//           moduleCache[cacheKey] = result;
//         }
//         return result;
//       } catch (e) {
//         console.group('[MCP] Native Module Error');
//         console.error('Failed to load module ' + id + ':', e);
//         console.groupEnd();
//         return undefined;
//       }
//     }

//     return undefined;
//   }

//   // Create shimmed require function that uses requireNativeModule for restricted APIs
//   var shimmedRequire = function(id, options) {
//     // Normalize module id (strip node: prefix)
//     var normalizedId = id.replace(/^node:/, '');

//     // Handle shimmed modules
//     if (normalizedId === 'module') return moduleShim;

//     // Handle fs modules - requires scope option for scoped access
//     if (normalizedId === 'fs') {
//       return getCachedModule('fs', options);
//     }
//     if (normalizedId === 'fs/promises') {
//       var fs = getCachedModule('fs', options);
//       return fs ? fs.promises : undefined;
//     }

//     // Handle process module via requireNativeModule
//     if (normalizedId === 'process') {
//       var processModule = getCachedModule('process', options);
//       // Fall back to global process shim if not available
//       return processModule || globalThis.process;
//     }

//     // Handle child_process module
//     if (normalizedId === 'child_process') {
//       return getCachedModule('child_process', options);
//     }

//     // Handle os module via requireNativeModule
//     if (normalizedId === 'os') {
//       return getCachedModule('os', options);
//     }

//     // Handle util module via requireNativeModule
//     if (normalizedId === 'util') {
//       return getCachedModule('util', options);
//     }

//     // Handle v8 module via requireNativeModule
//     if (normalizedId === 'v8') {
//       return getCachedModule('v8', options);
//     }

//     // Handle dialog module (Blockbench-specific)
//     if (normalizedId === 'dialog') {
//       return getCachedModule('dialog', options);
//     }

//     // Handle http module - implement using net module for functional HTTP server
//     if (normalizedId === 'http') {
//       var netModule = getCachedModule('net', { message: 'HTTP server requires network access' });

//       // HTTP status codes
//       var STATUS_CODES = {
//         100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created',
//         204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
//         400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
//         405: 'Method Not Allowed', 500: 'Internal Server Error', 502: 'Bad Gateway',
//         503: 'Service Unavailable'
//       };

//       // Create a functional HTTP server using net module
//       function createServer(requestListener) {
//         if (!netModule) {
//           throw new Error('HTTP server requires network permission. Use requireNativeModule("net") first.');
//         }

//         var server = netModule.createServer(function(socket) {
//           var buffer = Buffer.alloc(0);

//           socket.on('data', function(chunk) {
//             buffer = Buffer.concat([buffer, chunk]);

//             while (true) {
//               // Check for complete HTTP headers
//               var headerEnd = buffer.indexOf('\\r\\n\\r\\n');
//               if (headerEnd === -1) return;

//               var headerSection = buffer.subarray(0, headerEnd).toString();
//               var lines = headerSection.split('\\r\\n');
//               var requestLine = lines[0].split(' ');

//               // Parse headers
//               var headers = {};
//               for (var i = 1; i < lines.length; i++) {
//                 var colonIdx = lines[i].indexOf(':');
//                 if (colonIdx > 0) {
//                   var key = lines[i].substring(0, colonIdx).trim().toLowerCase();
//                   var value = lines[i].substring(colonIdx + 1).trim();
//                   headers[key] = value;
//                 }
//               }

//               var bodyStart = headerEnd + 4;
//               var contentLength = parseInt(headers['content-length'] || '0', 10) || 0;
//               var requestEnd = bodyStart + contentLength;
//               if (buffer.length < requestEnd) return;

//               var bodySection = buffer.subarray(bodyStart, requestEnd).toString();
//               buffer = buffer.subarray(requestEnd);

//               var _dataListeners = [];
//               var _endListeners = [];
//               var _flushed = false;

//               function flushReqEvents() {
//                 if (_flushed) return;
//                 _flushed = true;

//                 // Emit asynchronously to better match Node.js stream behavior
//                 setTimeout(function() {
//                   if (bodySection !== '') {
//                     for (var i = 0; i < _dataListeners.length; i++) {
//                       try { _dataListeners[i](bodySection); } catch (e) {}
//                     }
//                   }

//                   for (var j = 0; j < _endListeners.length; j++) {
//                     try { _endListeners[j](); } catch (e2) {}
//                   }
//                 }, 0);
//               }

//               // Create request object
//               var req = {
//                 method: requestLine[0],
//                 url: requestLine[1],
//                 httpVersion: '1.1',
//                 headers: headers,
//                 socket: socket,
//                 body: bodySection,
//                 on: function(event, cb) {
//                   if (event === 'data') {
//                     _dataListeners.push(cb);
//                     flushReqEvents();
//                     return this;
//                   }
//                   if (event === 'end') {
//                     _endListeners.push(cb);
//                     flushReqEvents();
//                     return this;
//                   }
//                   return this;
//                 },
//                 once: function(event, cb) {
//                   var self = this;
//                   function wrapped() {
//                     try { cb.apply(null, arguments); } finally { self.off(event, wrapped); }
//                   }
//                   return this.on(event, wrapped);
//                 },
//                 off: function(event, cb) {
//                   var arr = event === 'data' ? _dataListeners : event === 'end' ? _endListeners : null;
//                   if (!arr) return this;
//                   for (var i = arr.length - 1; i >= 0; i--) {
//                     if (arr[i] === cb) arr.splice(i, 1);
//                   }
//                   return this;
//                 },
//                 emit: function(event) {
//                   flushReqEvents();
//                   return this;
//                 }
//               };

//               // Create response object
//               var res = {
//                 statusCode: 200,
//                 statusMessage: 'OK',
//                 headersSent: false,
//                 _headers: { 'Content-Type': 'text/plain' },
//                 setHeader: function(name, value) { this._headers[name.toLowerCase()] = value; },
//                 getHeader: function(name) { return this._headers[name.toLowerCase()]; },
//                 writeHead: function(status, reasonOrHeaders, headers) {
//                   if (this.headersSent) return this;
//                   this.statusCode = status;
//                   this.statusMessage = STATUS_CODES[status] || 'Unknown';
//                   var hdrs = typeof reasonOrHeaders === 'object' ? reasonOrHeaders : headers || {};
//                   for (var k in hdrs) { this._headers[k.toLowerCase()] = hdrs[k]; }
//                   this.headersSent = true;
//                   var headerStr = 'HTTP/1.1 ' + status + ' ' + this.statusMessage + '\\r\\n';
//                   for (var h in this._headers) { headerStr += h + ': ' + this._headers[h] + '\\r\\n'; }
//                   headerStr += '\\r\\n';
//                   socket.write(headerStr);
//                   return this;
//                 },
//                 write: function(data) {
//                   if (!this.headersSent) this.writeHead(this.statusCode);
//                   socket.write(data);
//                   return true;
//                 },
//                 end: function(data) {
//                   if (!this.headersSent) this.writeHead(this.statusCode);
//                   if (data) socket.write(data);
//                   socket.end();
//                 },
//                 on: function() { return this; }
//               };

//               if (requestListener) {
//                 requestListener(req, res);
//               }
//             }
//           });

//           socket.on('error', function() {});
//         });

//         return server;
//       }

//       return {
//         METHODS: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
//         STATUS_CODES: STATUS_CODES,
//         Agent: function() {},
//         ClientRequest: function() {},
//         IncomingMessage: function() {},
//         ServerResponse: function() {},
//         Server: function() { return createServer(); },
//         createServer: createServer,
//         request: function() { console.group('[MCP] HTTP Warning'); console.warn('http.request not implemented - use https via requireNativeModule'); console.groupEnd(); },
//         get: function() { console.group('[MCP] HTTP Warning'); console.warn('http.get not implemented - use https via requireNativeModule'); console.groupEnd(); }
//       };
//     }

//     // Handle https module via requireNativeModule
//     if (normalizedId === 'https') {
//       return getCachedModule('https', options);
//     }

//     // Handle net module via requireNativeModule
//     if (normalizedId === 'net') {
//       return getCachedModule('net', options);
//     }

//     // Handle tls module via requireNativeModule
//     if (normalizedId === 'tls') {
//       return getCachedModule('tls', options);
//     }

//     // Handle tty (return stub - not available in Blockbench)
//     if (normalizedId === 'tty') {
//       return {
//         isatty: function() { return false; },
//         ReadStream: function() {},
//         WriteStream: function() {}
//       };
//     }

//     // Handle path module - available as PathModule global
//     if (normalizedId === 'path') {
//       return typeof PathModule !== 'undefined' ? PathModule : originalRequire('path');
//     }

//     // Handle safe modules that don't require permission
//     var safeModules = ['crypto', 'events', 'zlib', 'timers', 'url', 'string_decoder', 'querystring', 'buffer', 'stream', 'assert'];
//     if (safeModules.indexOf(normalizedId) !== -1) {
//       return originalRequire.call(this, id);
//     }

//     // Fall through to original require for other modules
//     return originalRequire.apply(this, arguments);
//   };

//   // Copy all properties from original require
//   for (var key in originalRequire) {
//     if (originalRequire.hasOwnProperty(key)) {
//       shimmedRequire[key] = originalRequire[key];
//     }
//   }

//   // Override global require
//   if (typeof require !== 'undefined') {
//     require = shimmedRequire;
//   }

//   // Also try to override module.require if available
//   if (typeof module !== 'undefined' && module.require) {
//     module.require = shimmedRequire;
//   }

//   // Expose helper for direct requireNativeModule access with options
//   globalThis.__bbRequireNative = function(id, options) {
//     return getCachedModule(id, options);
//   };
// })();

// `;
    
//     await writeFile(mcpFile, shims + mcpContent, "utf-8");
//     console.log("[Build] Injected Blockbench compatibility shims");
//   } catch (error: unknown) {
//     console.group("[Build] Shim Error");
//     console.error("Failed to inject shims:", error);
//     console.groupEnd();
//   }

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
