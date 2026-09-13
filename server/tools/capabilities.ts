/// <reference types="blockbench-types" />
import { z } from "zod";
import { BUILD_ID, BUILD_MODE, STATUS_STABLE, VERSION, type BuildMode } from "@/lib/constants";
import { createTool, tools, type IToolSpec } from "@/lib/factories";
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

/** Detailed feature flags for one format; `null` marks a flag the host did not declare as a boolean. */
interface IFormatSummary {
  id: string;
  name: string;
  features: FormatFeatures;
}

/** Host application version and runtime environment. */
interface IBlockbenchSummary {
  version: string;
  environment: "desktop" | "web";
  platform: string;
  is_mobile: boolean;
}

/** Identity of the running plugin bundle, used to match release evidence. */
interface IPluginSummary {
  version: string;
  build_id: string;
  build_mode: BuildMode;
}

/** Totals for the active project; `meshes` and `cubes` are subsets of `elements`. */
interface IProjectCounts {
  elements: number;
  meshes: number;
  cubes: number;
  groups: number;
  textures: number;
  animations: number;
}

/** Identity, format, and totals of the active project. */
interface IProjectSummary {
  uuid: string;
  name: string;
  format_id: string;
  counts: IProjectCounts;
}

/** Compact support listing for one registered format; `unknown_features` is omitted when empty. */
interface IRegisteredFormatSummary {
  id: string;
  name: string;
  supported_features: FormatFeatureName[];
  unknown_features?: FormatFeatureName[];
}

/** Current effective tool availability; individual arguments still need runtime validation. */
interface IToolRegistrationSummary {
  name: string;
  status: StatusType;
  enabled: boolean;
}

/**
 * Detached discovery result for planning tool calls without changing projects.
 * `format` describes the requested format, or the active project's format.
 * `formats` lists true feature flags; absent flags are false unless listed in
 * `unknown_features`. Null feature values mean the host did not declare them.
 * Optional `tools` describes current availability under the native editor conditions.
 */
export interface ICapabilitiesSnapshot {
  blockbench: IBlockbenchSummary;
  plugin: IPluginSummary;
  project: IProjectSummary | null;
  format: IFormatSummary | null;
  formats: IRegisteredFormatSummary[];
  tools?: IToolRegistrationSummary[];
  notes: string[];
}

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
    .describe("Include all registered MCP tool names, stability status, and current enabled state. Use list_modes and set_mode to navigate before calling mode-dependent tools."),
});

/**
 * Spec for the single `get_capabilities` tool, shared by
 * `registerCapabilityTools` and the docs manifest. Its read-only, idempotent,
 * closed-world annotations tell MCP clients the call is safe to repeat before
 * planning edits. Built without Blockbench globals so it imports outside the host.
 */
export const capabilityToolDocs: IToolSpec[] = [
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

/** Reads the tracked feature flags of one format, mapping non-boolean declarations to `null`. */
function summarizeFormat(format: ModelFormat): IFormatSummary {
  const features = Object.fromEntries(featureNames.map((name) => {
    const value: unknown = format[name];
    return [name, typeof value === "boolean" ? value : null];
  })) as FormatFeatures;
  return { id: format.id, name: format.name, features };
}

/** Copies project identity and totals so callers cannot mutate host arrays. */
function summarizeProject(project: ModelProject): IProjectSummary {
  return {
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
  };
}

/** Lists every registered format by ID with its true and undeclared feature flags. */
function summarizeRegisteredFormats(formats: Record<string, ModelFormat>): IRegisteredFormatSummary[] {
  return Object.values(formats)
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
    });
}

/** Lists every registered MCP tool by name with detached status and enabled state. */
function summarizeTools(): IToolRegistrationSummary[] {
  return Object.values(tools)
    .toSorted((first, second) => first.name.localeCompare(second.name))
    .map(({ name, status, enabled }) => ({ name, status, enabled }));
}

/** Builds a detached snapshot; rejects `format_id` values that are not own keys of the format registry. */
function inspectCapabilities({ format_id, include_tools }: z.infer<typeof getCapabilitiesParameters>): ICapabilitiesSnapshot {
  const formats = typeof Formats === "undefined" ? {} : Formats;
  if (format_id && !Object.hasOwn(formats, format_id)) {
    throw new Error(`Unknown format ID "${format_id}". Call get_capabilities without format_id and choose an ID from formats.`);
  }

  const project = typeof Project === "undefined" ? null : Project;
  const format = format_id ? formats[format_id] : project?.format;

  return {
    blockbench: {
      version: Blockbench.version,
      environment: Blockbench.isWeb ? "web" : "desktop",
      platform: Blockbench.platform,
      is_mobile: Blockbench.isMobile,
    },
    plugin: { version: VERSION, build_id: BUILD_ID, build_mode: BUILD_MODE },
    project: project ? summarizeProject(project) : null,
    format: format ? summarizeFormat(format) : null,
    formats: summarizeRegisteredFormats(formats),
    ...(include_tools ? { tools: summarizeTools() } : {}),
    notes: [
      "Format features are host declarations, not guarantees of MCP tool compatibility. Null or unknown_features means the host did not declare a boolean value; supported_features lists true flags.",
      "Tool enabled state reflects native editor conditions. Use list_modes and set_mode to change editor tabs, then refresh tools/list. Calls still validate individual arguments.",
    ],
  };
}

/**
 * Registers `get_capabilities`, which reads Blockbench, project, format, and
 * tool registries only when called, so clients can discover support with or
 * without an open project. Results are returned both as JSON text (for clients
 * without structured output) and as `structuredContent` shaped as
 * {@link ICapabilitiesSnapshot}. Importing this module never reads host globals.
 */
export function registerCapabilityTools(): void {
  const spec = capabilityToolDocs[0];
  createTool(spec.name, {
    ...spec,
    parameters: getCapabilitiesParameters,
    async execute(args) {
      const result = inspectCapabilities(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
      };
    },
  }, spec.status);
}
