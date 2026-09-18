import type { Resource, TextResourceContents } from "@modelcontextprotocol/sdk/types.js";
import type { INamedItem } from "@/lib/resourceUri";
import { resourceNotFound } from "@/lib/resourceErrors";

/**
 * Identifies a live project file independently of its name or local save path.
 *
 * @param project - An open project's UUID; names can change without invalidating this URI.
 * @returns The virtual `.bbmodel` URI, readable while this project is active.
 */
export function getProjectFileUri(project: Pick<INamedItem, "uuid">): string {
  return `blockbench://project/${encodeURIComponent(project.uuid)}.bbmodel`;
}

/**
 * Describes the active project's downloadable, live `.bbmodel` snapshot.
 *
 * @param project - The active project's UUID and optional display name.
 * @returns Metadata suitable for both `resources/list` and a tool's `resource_link`.
 */
export function getProjectFileResource(project: INamedItem): Resource {
  const name = (project.name || project.uuid).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  return {
    uri: getProjectFileUri(project),
    name: /\.bbmodel$/i.test(name) ? name : `${name}.bbmodel`,
    title: `${project.name || project.uuid} project file`,
    description: "Live Blockbench project file, including unsaved edits and embedded textures. Readable while this project is active; select it again if unavailable.",
    mimeType: "application/json",
  };
}

/**
 * Lists the live file only for the active project, because the native codec uses editor globals.
 *
 * @returns Zero or one file descriptor. Listing never compiles or switches project tabs.
 */
export function listProjectFiles(): { resources: Resource[] } {
  if (typeof Project === "undefined" || !Project) return { resources: [] };
  return { resources: [getProjectFileResource(Project)] };
}

/**
 * Compiles the active project's current model through Blockbench's native project codec.
 *
 * The codec preserves supported format/plugin fields and embeds textures. It does not save
 * to disk, change project tabs, or capture undo history/editor state. Inactive project URIs
 * are unavailable until selected, avoiding the playback and view changes of tab switching.
 *
 * @param uri - An exact URI returned by {@link getProjectFileUri} for the active project.
 * @returns A text resource containing uncompressed `.bbmodel` JSON.
 * @throws {McpError} If the project is absent, inactive, or the URI does not match.
 * @throws {Error} If the native codec is unavailable or produces an invalid model.
 */
export function readProjectFile(uri: URL): { contents: TextResourceContents[] } {
  if (typeof Project === "undefined" || !Project || uri.href !== getProjectFileUri(Project)) {
    throw resourceNotFound(uri, "Project file is unavailable. Select the project in Blockbench and list resources again.");
  }
  const codec = typeof Codecs === "undefined" ? undefined : Codecs.project;
  if (!codec || typeof codec.compile !== "function") throw new Error("Blockbench's project codec is unavailable.");
  if (Blockbench.hasFlag("compiling_bbmodel")) throw new Error("Blockbench is already compiling a project. Try reading the resource again when it finishes.");
  try {
    const model: unknown = codec.compile({ raw: true, bitmaps: true, absolute_paths: false });
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw new Error("Blockbench's project codec did not return a project model.");
    }
    return {
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(model) }],
    };
  } finally {
    // The native codec clears this on success, but not when a plugin's compile
    // listener throws. A failed read must not leave subsequent exports blocked.
    Blockbench.removeFlag("compiling_bbmodel");
  }
}
