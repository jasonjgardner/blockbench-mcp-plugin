/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { getProjectFileResource } from "@/lib/projectResources";
import { createEmbeddedExport } from "@/lib/tool-results";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCondition } from "@/server/tool-conditions";

/** Options for listing registered codecs without requiring an open project. */
export const listExportFormatsParameters = z.object({
  only_current_format: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, only return codecs compatible with the current project's format."
    ),
});

/** Export selection, optional local destination, and bounded MCP result format. */
export const exportModelParameters = z.object({
  codec_id: z
    .string()
    .optional()
    .describe(
      "Codec ID to use for export (e.g., 'obj', 'gltf', 'project', 'bedrock'). If omitted, uses the current project format's codec. Use `list_export_formats` to see available IDs."
    ),
  options: z
    .record(z.unknown())
    .optional()
    .describe(
      "Codec-specific export options, merged over the codec's configured export options (keys match the native export dialog). glTF ('gltf'): encoding ('ascii' | 'binary'), scale, embed_textures, armature (export groups as skinned bones), animations, and merge_armature (Blockbench 5.2+; default false exports one SkinnedMesh per armature child mesh, true merges each armature's meshes into a single SkinnedMesh)."
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Absolute filesystem path to write the compiled model to. Requires user permission (Blockbench v5.0+ prompts for 'fs' access). If omitted, content is returned in the response only."
    ),
  max_content_length: z
    .number()
    .int()
    .min(0)
    .max(2_000_000)
    .optional()
    .default(100_000)
    .describe(
      "Maximum characters of text or base64 to return. Use 0 to omit file content. In embedded mode, only complete files within this limit are embedded; larger files return a truncated preview in metadata.content."
    ),
  result_format: z.enum(["text", "embedded"]).default("text").describe(
    "text preserves the JSON metadata.content payload. embedded moves a complete file into an MCP resource block with URI and MIME type, sets metadata.content to null, and reports its resource_uri. Both modes include a link to the live .bbmodel project resource."
  ),
});

/** Discoverable export tools; runtime codec conditions are evaluated on every call. */
export const exportToolDocs: IToolSpec[] = [
  {
    name: "list_export_formats",
    description:
      "Lists registered export codecs, file extensions, compile/export support, and availability under the native export action's condition. Use before `export_model` to pick a codec.",
    annotations: {
      title: "List Export Formats",
      readOnlyHint: true,
    },
    parameters: listExportFormatsParameters,
    status: STATUS_STABLE,
  },
  {
    name: "export_model",
    description:
      "Compiles the current project through a codec whose native export action is available. Returns JSON metadata and a live .bbmodel resource link; result_format='embedded' returns complete exports as text/blob resources with URI and MIME type. Optionally writes to a local path (requires Blockbench filesystem permission). Partial codec options merge over the configured defaults; for glTF armatures, options.merge_armature=true merges each armature's meshes into one SkinnedMesh. Use `list_export_formats` to discover codecs.",
    condition: { project: true },
    annotations: {
      title: "Export Model",
      destructiveHint: false,
      openWorldHint: true,
    },
    parameters: exportModelParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

interface ICodecSummary {
  id: string;
  name: string;
  extension: string | null;
  has_compile: boolean;
  has_export: boolean;
  supports_partial_export: boolean;
  belongs_to_current_format: boolean;
  available: boolean;
}

function isExportAvailable(codec: { export_action?: { condition?: ToolCondition } }): boolean {
  if (!Project) return false;
  try {
    return !codec.export_action || Condition(codec.export_action.condition);
  } catch {
    // A third-party codec's condition must not make every other codec undiscoverable.
    return false;
  }
}

function isStringifiable(value: unknown): value is string {
  return typeof value === "string";
}

function toTextContent(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (isStringifiable(raw)) return raw;
  if (raw instanceof ArrayBuffer) {
    return `[binary: ${raw.byteLength} bytes]`;
  }
  if (typeof raw === "object") {
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

/** Registers codec discovery and export tools without evaluating host globals at import time. */
export function registerExportTools(): void {
  createTool(exportToolDocs[0].name, {
    ...exportToolDocs[0],
    async execute({ only_current_format }) {
      // @ts-ignore - Codecs is a Blockbench global
      const registry = Codecs as Record<string, unknown>;
      // @ts-ignore - Format is a Blockbench global
      const currentFormatCodecId = (Format as { codec?: { id?: string } } | undefined)
        ?.codec?.id;

      const summaries: ICodecSummary[] = Object.entries(registry).map(
        ([id, codec]) => {
          const c = codec as {
            id?: string;
            name?: string;
            extension?: string;
            compile?: unknown;
            export?: unknown;
            support_partial_export?: boolean;
            export_action?: { condition?: ToolCondition };
          };
          return {
            id,
            name: c.name ?? id,
            extension: c.extension ?? null,
            has_compile: typeof c.compile === "function",
            has_export: typeof c.export === "function",
            supports_partial_export: Boolean(c.support_partial_export),
            belongs_to_current_format: c.id === currentFormatCodecId,
            available: isExportAvailable(c),
          };
        }
      );

      const filtered = only_current_format
        ? summaries.filter((s) => s.belongs_to_current_format)
        : summaries;

      return JSON.stringify(
        {
          current_format_codec: currentFormatCodecId ?? null,
          count: filtered.length,
          codecs: filtered.sort((a, b) => a.id.localeCompare(b.id)),
        },
        null,
        2
      );
    },
  }, exportToolDocs[0].status);

  createTool(exportToolDocs[1].name, {
    ...exportToolDocs[1],
    async execute({ codec_id, options, path, max_content_length, result_format }): Promise<CallToolResult> {
      if (!Project) {
        throw new Error(
          "No project is open. Use `create_project` or open a project first."
        );
      }
      const project = Project;

      // @ts-ignore - Codecs is a Blockbench global
      const registry = Codecs as Record<
        string,
        {
          id?: string;
          name?: string;
          extension?: string;
          // Some codecs (e.g. glTF) return a Promise from compile().
          compile?: (opts?: unknown) => unknown | Promise<unknown>;
          getExportOptions?: () => Record<string, unknown>;
          fileName?: () => string;
          export_action?: { condition?: ToolCondition };
        }
      >;

      // @ts-ignore - Format is a Blockbench global
      const formatCodec = (Format as { codec?: { id?: string } } | undefined)?.codec;
      const resolvedId = codec_id ?? formatCodec?.id;

      if (!resolvedId) {
        throw new Error(
          "No codec_id provided and the current project format has no default codec. Use `list_export_formats` to pick one."
        );
      }

      const codec = registry[resolvedId];
      if (!codec) {
        const available = Object.keys(registry).sort().slice(0, 20).join(", ");
        throw new Error(
          `Codec "${resolvedId}" not found. Available (first 20): ${available}. Use \`list_export_formats\` for the full list.`
        );
      }

      if (typeof codec.compile !== "function") {
        throw new Error(
          `Codec "${resolvedId}" does not support programmatic export (no compile() method).`
        );
      }

      if (!isExportAvailable(codec)) {
        throw new Error(
          `Codec "${resolvedId}" is unavailable in the current project or mode. Use \`list_export_formats\` to find an available codec.`
        );
      }

      // Merge partial options over the configured defaults, as the native
      // glTF codec does, so passing only e.g. { merge_armature: true } keeps
      // every other export setting.
      const defaultOptions = typeof codec.getExportOptions === "function"
        ? codec.getExportOptions()
        : undefined;
      const effectiveOptions = options ? { ...defaultOptions, ...options } : defaultOptions;
      const fileName = typeof codec.fileName === "function" ? codec.fileName() : project.name;

      // Await so async codecs (glTF/etc.) resolve before we stringify/write.
      // Sync codecs (obj, bedrock, project) pass through via Promise.resolve.
      const rawResult = await Promise.resolve(codec.compile(effectiveOptions));

      const isArrayBuffer = rawResult instanceof ArrayBuffer;
      const isBinaryView = ArrayBuffer.isView(rawResult);
      const binaryBuffer = isArrayBuffer
        ? Buffer.from(rawResult as ArrayBuffer)
        : isBinaryView
          ? Buffer.from(
              (rawResult as ArrayBufferView).buffer,
              (rawResult as ArrayBufferView).byteOffset,
              (rawResult as ArrayBufferView).byteLength
            )
          : null;

      const text = binaryBuffer ? null : toTextContent(rawResult);
      const byteLength = binaryBuffer
        ? binaryBuffer.byteLength
        : Buffer.byteLength(text ?? "", "utf8");
      const encoding: "utf-8" | "base64" = binaryBuffer ? "base64" : "utf-8";

      let wrote_to_path: string | null = null;
      if (path) {
        // @ts-ignore - requireNativeModule is a Blockbench global
        const fs = requireNativeModule("fs", {
          message: `MCP export_model requested write access to save model to ${path}`,
        });
        if (!fs) {
          throw new Error(
            "File system access was denied. Unable to write to path. You can omit `path` to retrieve the content in the response."
          );
        }
        fs.writeFileSync(path, binaryBuffer ?? (text ?? ""));
        wrote_to_path = path;
      }

      const fullContent = binaryBuffer
        ? binaryBuffer.toString("base64")
        : (text ?? "");
      const truncated = fullContent.length > max_content_length;
      const returnedContent = max_content_length === 0
        ? null
        : truncated
          ? fullContent.slice(0, max_content_length)
          : fullContent;

      const embedded = result_format === "embedded" && max_content_length > 0 && !truncated
        ? createEmbeddedExport({
          projectId: project.uuid,
          codecId: resolvedId,
          fileName,
          extension: codec.extension,
          content: fullContent,
          encoding,
        })
        : undefined;
      const metadata = {
        codec: {
          id: resolvedId,
          name: codec.name ?? resolvedId,
          extension: codec.extension ?? null,
        },
        file_name: fileName,
        byte_length: byteLength,
        encoding,
        wrote_to_path,
        truncated,
        content: embedded ? null : returnedContent,
        resource_uri: embedded?.resource.uri ?? null,
      };
      const projectLink = Project === project
        ? [{ type: "resource_link" as const, ...getProjectFileResource(project) }]
        : [];
      return {
        content: [
          { type: "text", text: JSON.stringify(metadata, null, 2) },
          ...(embedded ? [embedded] : []),
          ...projectLink,
        ],
        structuredContent: metadata,
      };
    },
  }, exportToolDocs[1].status);
}
