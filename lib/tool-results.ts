import type { EmbeddedResource } from "@modelcontextprotocol/sdk/types.js";

/**
 * A compiled export's identity and complete payload, independent of Blockbench
 * globals so binary/text resource formatting can be validated outside the app.
 */
export interface IExportResourceInput {
  /** UUID of the project that was compiled. */
  projectId: string;
  /** Codec ID, used to resolve formats whose extension depends on encoding. */
  codecId: string;
  /** Codec-provided file name; directory components are removed from the URI. */
  fileName: string;
  /** Codec's configured extension, without a leading dot. */
  extension?: string;
  /** Complete text or base64 payload. Never pass a truncated preview. */
  content: string;
  /** Whether `content` contains UTF-8 text or base64-encoded bytes. */
  encoding: "utf-8" | "base64";
}

const TEXT_MIME_TYPES: Readonly<Record<string, string>> = {
  bbmodel: "application/json",
  gltf: "model/gltf+json",
  json: "application/json",
  obj: "model/obj",
  svg: "image/svg+xml",
  xml: "application/xml",
};

const BINARY_MIME_TYPES: Readonly<Record<string, string>> = {
  glb: "model/gltf-binary",
  png: "image/png",
  zip: "application/zip",
};

/**
 * Wraps a complete codec export as an MCP embedded resource. Each invocation
 * receives a distinct URI because these bytes are an immutable result snapshot,
 * unlike the live project resource. The URI identifies the embedded bytes; it
 * does not promise a separately readable resource or expose a filesystem path.
 *
 * @param input - Complete export bytes and their originating codec/project.
 * @returns A text or base64 blob resource with a format-appropriate MIME type.
 */
export function createEmbeddedExport(input: IExportResourceInput): EmbeddedResource {
  const binary = input.encoding === "base64";
  const extension = input.codecId === "gltf" && binary
    ? "glb"
    : (input.extension ?? "").replace(/^\.+/, "").toLowerCase();
  const sourceName = input.fileName.split(/[/\\]/).at(-1)?.trim() || "model";
  const leafName = input.codecId === "gltf" && binary
    ? sourceName.replace(/\.gltf$/i, "")
    : sourceName;
  const fileName = !extension || leafName.toLowerCase().endsWith(`.${extension}`)
    ? leafName
    : `${leafName}.${extension}`;
  const mimeTypes = binary ? BINARY_MIME_TYPES : TEXT_MIME_TYPES;
  const mimeType = mimeTypes[extension] ?? (binary ? "application/octet-stream" : "text/plain");
  const uri = `blockbench://export/${encodeURIComponent(input.projectId)}/${crypto.randomUUID()}/${encodeURIComponent(fileName)}`;

  if (binary) return { type: "resource", resource: { uri, mimeType, blob: input.content } };
  return { type: "resource", resource: { uri, mimeType, text: input.content } };
}
