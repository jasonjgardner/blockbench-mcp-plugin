/**
 * Writing export results to a caller-given path, shared by `export_model` and
 * the GeckoLib export tools.
 */

/** Minimal shape of the `fs` module used here; Blockbench hands it out through `requireNativeModule`. */
interface IExportFs {
  writeFileSync(path: string, data: string | Uint8Array, options?: { flag?: string }): void;
}

/**
 * Windows drive (`C:\`, `C:/`) or POSIX (`/`) absolute path. Network (`\\server\share`, `//server/share`)
 * and device (`\\?\`, `\\.\`) paths are refused: writing to them makes Windows connect to the named host
 * with the user's credentials. A mapped drive letter still works.
 */
export function isAbsoluteExportPath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/(?![\\/]))/.test(path);
}

/**
 * Writes export content to disk through Blockbench's permission-checked `fs`.
 *
 * Relative paths are refused because they resolve against Blockbench's working
 * directory, not the caller's. Existing files are only replaced when
 * `overwrite` is true: silently replacing a reference file during a
 * re-export-and-compare run would make the comparison pass trivially.
 *
 * @param path - Absolute destination path.
 * @param data - Text or binary content.
 * @param overwrite - Replace the file when it already exists.
 * @param label - Tool name shown in the permission prompt and errors.
 * @returns The path written.
 * @throws {Error} For relative, network or device paths, denied access, or an existing file without `overwrite`.
 */
export function writeExportFile(path: string, data: string | Uint8Array, overwrite: boolean, label: string): string {
  if (!isAbsoluteExportPath(path)) {
    throw new Error(`${label}: path must be an absolute local path; relative, network (UNC) and device paths are refused (got "${path}").`);
  }
  // @ts-ignore - requireNativeModule is a Blockbench global
  const fs: IExportFs | undefined = requireNativeModule("fs", {
    message: `MCP ${label} requested write access to save to ${path}`,
  });
  if (!fs) {
    throw new Error("File system access was denied. Omit `path` to receive the content in the response instead.");
  }
  try {
    fs.writeFileSync(path, data, { flag: overwrite ? "w" : "wx" });
  } catch (error) {
    const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    if (code === "EEXIST") {
      throw new Error(`${label}: ${path} already exists. Pass overwrite: true to replace it.`);
    }
    throw error;
  }
  return path;
}
