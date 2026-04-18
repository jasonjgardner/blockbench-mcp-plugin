/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";

export const listExportFormatsParameters = z.object({
  only_current_format: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, only return codecs compatible with the current project's format."
    ),
});

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
      "Codec-specific export options. Defaults to the codec's configured export options."
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
      "Maximum number of characters to include in the returned `content` field. Use 0 to omit content entirely (useful when only writing to disk). Larger values risk exceeding MCP context limits."
    ),
});

export const exportToolDocs: ToolSpec[] = [
  {
    name: "list_export_formats",
    description:
      "Lists all registered export codecs with their id, display name, file extension, and whether they support compile/export. Use before `export_model` to pick a codec.",
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
      "Compiles the current project through the named codec and returns the result as text. Optionally writes the compiled content to a filesystem path (requires user permission in Blockbench v5.0+). Use `list_export_formats` first to discover codec IDs.",
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

export function registerExportTools() {
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
          };
          return {
            id,
            name: c.name ?? id,
            extension: c.extension ?? null,
            has_compile: typeof c.compile === "function",
            has_export: typeof c.export === "function",
            supports_partial_export: Boolean(c.support_partial_export),
            belongs_to_current_format: c.id === currentFormatCodecId,
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
    async execute({ codec_id, options, path, max_content_length }) {
      if (!Project) {
        throw new Error(
          "No project is open. Use `create_project` or open a project first."
        );
      }

      // @ts-ignore - Codecs is a Blockbench global
      const registry = Codecs as Record<
        string,
        {
          id?: string;
          name?: string;
          extension?: string;
          compile?: (opts?: unknown) => unknown;
          getExportOptions?: () => Record<string, unknown>;
          fileName?: () => string;
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

      const effectiveOptions =
        options ??
        (typeof codec.getExportOptions === "function"
          ? codec.getExportOptions()
          : undefined);

      const rawResult = codec.compile(effectiveOptions);
      const text = toTextContent(rawResult);
      const byteLength = text.length;

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
        fs.writeFileSync(path, text);
        wrote_to_path = path;
      }

      const truncated = byteLength > max_content_length;
      const returnedContent = max_content_length === 0
        ? null
        : truncated
          ? text.slice(0, max_content_length)
          : text;

      return JSON.stringify(
        {
          codec: {
            id: resolvedId,
            name: codec.name ?? resolvedId,
            extension: codec.extension ?? null,
          },
          file_name: typeof codec.fileName === "function"
            ? codec.fileName()
            : Project.name,
          byte_length: byteLength,
          wrote_to_path,
          truncated,
          content: returnedContent,
        },
        null,
        2
      );
    },
  }, exportToolDocs[1].status);
}
