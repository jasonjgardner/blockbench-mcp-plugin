/// <reference types="blockbench-types" />
import { z } from "zod";
import { STATUS_STABLE, VERSION } from "@/lib/constants";
import { createTool, tools, type ToolSpec } from "@/lib/factories";
import type { StatusType } from "@/types";

// Keep discovery focused on the format properties that affect modeling tools.
// Missing properties remain unknown, which matters when the host is older than
// the plugin or a third-party format omits a feature declaration.
const featureNames = [
  "meshes",
  "bone_rig",
  "edit_mode",
  "paint_mode",
  "image_editor",
  "animation_mode",
  "animation_files",
  "animation_controllers",
  "display_mode",
  "box_uv",
  "optional_box_uv",
  "single_texture",
  "per_texture_uv_size",
  "pbr",
  "rotate_cubes",
  "rotation_limit",
  "texture_meshes",
  "locators",
] as const satisfies readonly (keyof ModelFormat)[];

type FormatFeatureName = (typeof featureNames)[number];
type FormatFeatures = Record<FormatFeatureName, boolean | null>;
type FormatSummary = { id: string; name: string; features: FormatFeatures };

/**
 * Detached discovery result for planning tool calls without changing projects.
 * `format` describes the requested format, or the active project's format.
 * `formats` lists true feature flags; absent flags are false unless listed in
 * `unknown_features`. Null feature values mean the host did not declare them.
 * Optional `tools` describes registration state, not per-project compatibility.
 */
export type CapabilitiesSnapshot = {
  blockbench: {
    version: string;
    environment: "desktop" | "web";
    platform: string;
    is_mobile: boolean;
  };
  plugin: { version: string };
  project: {
    uuid: string;
    name: string;
    format_id: string;
    counts: {
      elements: number;
      meshes: number;
      cubes: number;
      groups: number;
      textures: number;
      animations: number;
    };
  } | null;
  format: FormatSummary | null;
  formats: Array<{
    id: string;
    name: string;
    supported_features: FormatFeatureName[];
    unknown_features?: FormatFeatureName[];
  }>;
  tools?: Array<{ name: string; status: StatusType; enabled: boolean }>;
  notes: string[];
};

/**
 * Discovery options safe to import outside Blockbench. Format identifiers are
 * validated against the live registry when called, so custom formats work too.
 */
export const getCapabilitiesParameters = z.object({
  format_id: z
    .string()
    .min(1)
    .optional()
    .describe("Optional registered format ID to inspect, such as 'free'. Defaults to the active project's format. Does not switch or create a project."),
  include_tools: z
    .boolean()
    .default(false)
    .describe("Include all registered MCP tool names, stability status, and enabled state. Enabled tools may still require a compatible format, project, mode, or selection."),
});

/** Documentation and read-only annotations shared by registration and API docs. */
export const capabilityToolDocs: ToolSpec[] = [
  {
    name: "get_capabilities",
    description: "Discover Blockbench/plugin versions, desktop or web environment, active project summary, and registered model formats. Returns detailed boolean format features (null means unknown), compact supported-feature lists for all formats, and optional tool registration states. Works with no open project. Format features do not guarantee that every enabled MCP tool can run in the current mode or selection.",
    annotations: {
      title: "Get Capabilities",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    parameters: getCapabilitiesParameters,
    status: STATUS_STABLE,
  },
];

function summarizeFormat(format: ModelFormat): FormatSummary {
  const features = Object.fromEntries(featureNames.map((name) => {
    const value: unknown = format[name];
    return [name, typeof value === "boolean" ? value : null];
  })) as FormatFeatures;
  return { id: format.id, name: format.name, features };
}

function inspectCapabilities({ format_id, include_tools }: z.infer<typeof getCapabilitiesParameters>): CapabilitiesSnapshot {
  const formats = typeof Formats === "undefined" ? {} : Formats;
  if (format_id && !Object.hasOwn(formats, format_id)) {
    throw new Error(`Unknown format ID "${format_id}". Call get_capabilities without format_id and choose an ID from formats.`);
  }

  const project = typeof Project === "undefined" ? null : Project;
  const format = format_id ? formats[format_id] : project?.format;
  const projectSummary = project ? {
    uuid: project.uuid,
    name: project.name,
    format_id: project.format.id,
    counts: {
      elements: project.elements.length,
      meshes: project.elements.filter((element) => element.type === "mesh").length,
      cubes: project.elements.filter((element) => element.type === "cube").length,
      groups: project.groups.length,
      textures: project.textures.length,
      animations: project.animations.length,
    },
  } : null;

  return {
    blockbench: {
      version: Blockbench.version,
      environment: Blockbench.isWeb ? "web" : "desktop",
      platform: Blockbench.platform,
      is_mobile: Blockbench.isMobile,
    },
    plugin: { version: VERSION },
    project: projectSummary,
    format: format ? summarizeFormat(format) : null,
    formats: Object.values(formats)
      .toSorted((first, second) => first.id.localeCompare(second.id))
      .map((registeredFormat) => {
        const summary = summarizeFormat(registeredFormat);
        const unknownFeatures = featureNames.filter((name) => summary.features[name] === null);
        return {
          id: summary.id,
          name: summary.name,
          supported_features: featureNames.filter((name) => summary.features[name] === true),
          ...(unknownFeatures.length > 0 ? { unknown_features: unknownFeatures } : {}),
        };
      }),
    ...(include_tools ? {
      tools: Object.values(tools)
        .toSorted((first, second) => first.name.localeCompare(second.name))
        .map(({ name, status, enabled }) => ({ name, status, enabled })),
    } : {}),
    notes: [
      "Format features are host declarations, not guarantees of MCP tool compatibility. Null or unknown_features means the host did not declare a boolean value; supported_features lists true flags.",
      "Tool enabled state reflects plugin registration. Calls may also require a compatible project format, editor mode, or selection.",
    ],
  };
}

/** Register read-only runtime discovery; importing schemas never reads host globals. */
export function registerCapabilityTools(): void {
  const spec = capabilityToolDocs[0];
  createTool(spec.name, {
    ...spec,
    parameters: getCapabilitiesParameters,
    async execute(args) {
      const result = inspectCapabilities(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  }, spec.status);
}
