import { type BunPlugin } from "bun";
import { minifyHTML, minifyCSS, minifySVG, isProduction } from "./utils";
import { resolve } from "node:path";

/**
 * Bun plugin to import HTML, CSS, and SVG files as strings
 * Applies minification in production builds
 *
 * Uses onResolve to resolve full paths and mark files for custom loading,
 * then onLoad to process them. This ensures Bun doesn't use its default file loader.
 */
export const textFileLoaderPlugin: BunPlugin = {
  name: "text-file-loader",
  setup(build) {
    const projectRoot = resolve(".");

    // Resolve path, handling @/ alias
    const resolvePath = (importPath: string, resolveDir: string): string => {
      if (importPath.startsWith("@/")) {
        // @/ alias points to project root
        return resolve(projectRoot, importPath.slice(2));
      }
      return resolve(resolveDir, importPath);
    };

    // Resolve CSS imports to our custom namespace with full path
    build.onResolve({ filter: /\.css$/ }, (args) => {
      if (args.namespace === "text-file") return;
      // Skip node_modules
      if (args.resolveDir.includes("node_modules")) return;
      const resolvedPath = resolvePath(args.path, args.resolveDir);
      return {
        path: resolvedPath,
        namespace: "text-file",
      };
    });

    // Resolve HTML imports to our custom namespace with full path
    build.onResolve({ filter: /\.html$/ }, (args) => {
      if (args.namespace === "text-file") return;
      const resolvedPath = resolvePath(args.path, args.resolveDir);
      return {
        path: resolvedPath,
        namespace: "text-file",
      };
    });

    // Resolve SVG imports to our custom namespace with full path
    build.onResolve({ filter: /\.svg$/ }, (args) => {
      if (args.namespace === "text-file") return;
      // Skip node_modules
      if (args.resolveDir.includes("node_modules")) return;
      const resolvedPath = resolvePath(args.path, args.resolveDir);
      return {
        path: resolvedPath,
        namespace: "text-file",
      };
    });

    // Load files as text from the text-file namespace
    build.onLoad({ filter: /.*/, namespace: "text-file" }, async (args) => {
      try {
        const content = await Bun.file(args.path).text();
        const ext = args.path.slice(args.path.lastIndexOf("."));
        const minify = isProduction
          ? ext === ".css"
            ? minifyCSS
            : ext === ".svg"
              ? minifySVG
              : minifyHTML
          : (s: string) => s;
        const processed = minify(content);
        return {
          contents: `export default ${JSON.stringify(processed)};`,
          loader: "js",
        };
      } catch (err) {
        console.error(`[text-file-loader] Failed to load: ${args.path}`, err);
        throw err;
      }
    });
  },
};

/**
 * Bun plugin to replace restricted Node modules with Blockbench-compatible versions
 * Uses requireNativeModule() to avoid permission prompts in Blockbench v5.0+
 */
export const blockbenchCompatPlugin: BunPlugin = {
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