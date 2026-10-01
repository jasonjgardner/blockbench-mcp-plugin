/// <reference types="blockbench-types" />
/**
 * Local file references accepted by tools that read from disk: absolute paths
 * and `file://` URLs of files on this computer. Network and device paths are
 * refused: on Windows a UNC path (`\\server\share\file`) opens an SMB or WebDAV
 * connection with the user's credentials, silently once file access is
 * allowed, and a device (`\\.\pipe\name`, `\\?\…`, `COM1`) can block Blockbench
 * in a synchronous read. Reads go through Blockbench's permission-checked `fs`,
 * so the user decides whether the plugin may read files at all.
 *
 * @module
 */

/**
 * Windows names that open a device in any folder: with or without an extension, with trailing dots or spaces
 * (Win32 strips them from the last component, so `COM1 .txt` and `nul.` are devices) and with an alternate data
 * stream suffix (`CON:stream`).
 */
const RESERVED_DEVICE_NAME = /(^|[\\/])(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)[ .]*(\.[^\\/]*)?(:[^\\/]*)?$/i;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The path without control and formatting characters (line breaks, bidirectional overrides), for messages. */
function displayPath(path: string): string {
  return path.replace(/[\p{Cc}\p{Cf}]/gu, "");
}

/**
 * Whether `path` names a file on this computer: a Windows drive path (`C:\`,
 * `C:/`) or a path starting with a single `/`. Relative, UNC (`\\server\share`,
 * `//server/share`) and device paths (`\\.\`, `\\?\`, reserved names such as
 * `NUL` or `COM1`) are not.
 */
export function isAbsoluteLocalPath(path: string): boolean {
  if (RESERVED_DEVICE_NAME.test(path)) return false;
  return /^[A-Za-z]:[\\/]/.test(path) || /^\/(?![\\/])/.test(path);
}

/**
 * Converts a `file:` URL to a platform path with Node's `fileURLToPath`, which
 * decodes percent-escapes and handles Windows drive letters
 * (`file:///C:/My%20Models/a.png` → `C:\My Models\a.png`). Stripping the scheme
 * instead left `/C:/My%20Models/a.png`. The URL must not name a host
 * (`localhost` is dropped by URL parsing): `file://server/share/a.png` is a
 * network share. Other strings are returned unchanged.
 *
 * @throws {Error} For malformed file URLs and URLs naming another computer.
 */
export function toLocalPath(reference: string): string {
  if (!/^file:/i.test(reference)) return reference;
  let url: URL;
  try {
    url = new URL(reference);
  } catch (error) {
    throw new Error(`Invalid file URL "${displayPath(reference)}".`, { cause: error });
  }
  if (url.hostname !== "") {
    throw new Error(`File URLs must name a file on this computer, not on "${displayPath(url.hostname)}".`);
  }
  try {
    return requireNativeModule("url").fileURLToPath(url);
  } catch (error) {
    throw new Error(`Invalid file URL "${displayPath(reference)}": ${describeError(error)}`, { cause: error });
  }
}

/**
 * Blockbench's `fs` for reading `path`, once the path is known to name a local
 * file. Until the user allows file access, Blockbench asks with a prompt that
 * names the tool and the path.
 *
 * @param path - Absolute local path.
 * @param label - Tool name shown in the permission prompt and errors.
 * @throws {Error} For paths that are not local files, or when file access is denied.
 */
export function localFileSystem(path: string, label: string): ScopedFS {
  if (!isAbsoluteLocalPath(path)) {
    throw new Error(`${label}: "${displayPath(path)}" is not an absolute path to a file on this computer.`);
  }
  const fs = requireNativeModule("fs", { message: `MCP ${label} requested read access to load ${displayPath(path)}` });
  if (!fs) throw new Error("File system access was denied.");
  return fs;
}

/**
 * Reads a UTF-8 text file through {@link localFileSystem}.
 *
 * @throws {Error} As {@link localFileSystem}, or the file system error when the read fails.
 */
export function readLocalTextFile(path: string, label: string): string {
  return localFileSystem(path, label).readFileSync(path, "utf8");
}
