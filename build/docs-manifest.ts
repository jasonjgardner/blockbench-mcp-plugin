import { z } from "zod";
import type { ToolSpec, PromptSpec, ResourceSpec } from "../lib/factories";

// Tool docs imports — each file exports schemas at module level with zero Blockbench deps
import { cameraToolDocs } from "../server/tools/camera";
import { cubeToolDocs } from "../server/tools/cubes";
import { elementToolDocs } from "../server/tools/element";
import { importToolDocs } from "../server/tools/import";
import { meshToolDocs } from "../server/tools/mesh";
import { paintToolDocs } from "../server/tools/paint";
import { projectToolDocs } from "../server/tools/project";
import { textureToolDocs } from "../server/tools/texture";
import { armatureToolDocs } from "../server/tools/armature";
import { animationToolDocs } from "../server/tools/animation";
import { uiToolDocs } from "../server/tools/ui";
import { hytaleToolDocs } from "../server/tools/hytale";
import { materialInstanceToolDocs } from "../server/tools/material-instances";
import { uvToolDocs } from "../server/tools/uv";

export interface CategoryGroup {
  category: string;
  tools: ToolSpec[];
}

export const toolManifest: CategoryGroup[] = [
  { category: "Cubes", tools: cubeToolDocs },
  { category: "Camera & Screenshots", tools: cameraToolDocs },
  { category: "Animation", tools: animationToolDocs },
  { category: "Armature", tools: armatureToolDocs },
  { category: "Elements", tools: elementToolDocs },
  { category: "Import/Export", tools: importToolDocs },
  { category: "Material Instances", tools: materialInstanceToolDocs },
  { category: "Mesh Editing", tools: meshToolDocs },
  { category: "Paint Tools", tools: paintToolDocs },
  { category: "Project", tools: projectToolDocs },
  { category: "Textures", tools: textureToolDocs },
  { category: "UI Interaction", tools: uiToolDocs },
  { category: "UV Mapping", tools: uvToolDocs },
  { category: "Hytale Integration", tools: hytaleToolDocs },
];

// Prompt specs defined inline — server/prompts.ts uses macros that complicate direct import
export const promptDocs: PromptSpec[] = [
  {
    name: "blockbench_native_apis",
    description:
      "Essential information about Blockbench v5.0 native API security model and requireNativeModule() usage. Use this when working with Node.js modules, file system access, or native APIs in Blockbench plugins.",
    status: "stable",
  },
  {
    name: "blockbench_code_eval_safety",
    description:
      "Critical safety guide for agents using code evaluation/execution tools with Blockbench v5.0+. Contains breaking changes, quick reference, common mistakes, and safe code patterns for native module usage.",
    status: "stable",
  },
  {
    name: "model_creation_strategy",
    title: "Model Creation Strategy",
    description: "A strategy for creating a new 3D model in Blockbench.",
    argsSchema: z.object({
      format: z
        .enum(["java_block", "bedrock"])
        .optional()
        .describe("Target model format."),
      approach: z
        .enum(["ui", "programmatic", "import"])
        .optional()
        .describe("Creation approach to use."),
    }),
    status: "stable",
  },
  {
    name: "hytale_model_creation",
    title: "Hytale Model Creation Guide",
    description:
      "Comprehensive guide for creating Hytale character and prop models. Covers format selection, node limits, shading modes, stretch, quads, and best practices.",
    argsSchema: z.object({
      format_type: z
        .enum(["character", "prop", "both"])
        .describe("Which format type to focus on.")
        .optional()
        .default("both"),
    }),
    status: "experimental",
  },
  {
    name: "hytale_animation_workflow",
    title: "Hytale Animation Workflow",
    description:
      "Guide for creating animations for Hytale models. Covers 60 FPS timing, quaternion rotations, visibility keyframes, loop modes, and common animation patterns.",
    argsSchema: z.object({
      animation_type: z
        .enum(["walk", "idle", "attack", "general"])
        .describe("Type of animation to focus on.")
        .optional()
        .default("general"),
    }),
    status: "experimental",
  },
  {
    name: "hytale_attachments",
    title: "Hytale Attachments System",
    description:
      "Guide for creating and managing attachments in Hytale models. Covers attachment collections, piece bones, modular equipment, and best practices.",
    status: "experimental",
  },
];

// Resource specs defined inline — server/resources.ts uses Blockbench globals at module level
export const resourceDocs: ResourceSpec[] = [
  {
    name: "projects",
    uriTemplate: "projects://{id}",
    title: "Blockbench Projects",
    description:
      "Returns information about available projects in Blockbench. Use without an ID to list all projects, or provide a project UUID/name to get details about a specific project.",
  },
  {
    name: "nodes",
    uriTemplate: "nodes://{id}",
    title: "Blockbench Nodes",
    description: "Returns the current nodes in the Blockbench editor.",
  },
  {
    name: "textures",
    uriTemplate: "textures://{id}",
    title: "Blockbench Textures",
    description:
      "Returns information about textures in the current Blockbench project. Use without an ID to list all textures, or provide a texture UUID/name to get details about a specific texture.",
  },
  {
    name: "reference_models",
    uriTemplate: "reference_models://{id}",
    title: "Reference Models",
    description:
      "Returns information about reference models in the current Blockbench project. Requires the Reference Models plugin.",
  },
  {
    name: "validator-status",
    uriTemplate: "validator://status",
    title: "Validator Status",
    description:
      "Returns the current validation status including error/warning counts and a summary of all problems.",
  },
  {
    name: "validator-checks",
    uriTemplate: "validator://checks/{id}",
    title: "Validator Checks",
    description:
      "Returns information about registered validator checks. Use without an ID to list all checks, or provide a check ID to get details about a specific check.",
  },
  {
    name: "validator-warnings",
    uriTemplate: "validator://warnings",
    title: "Validator Warnings",
    description:
      "Returns all current validation warnings with element references where available.",
  },
  {
    name: "validator-errors",
    uriTemplate: "validator://errors",
    title: "Validator Errors",
    description:
      "Returns all current validation errors with element references where available.",
  },
  {
    name: "hytale-format",
    uriTemplate: "hytale://format",
    title: "Hytale Format Information",
    description:
      "Returns comprehensive information about the current Hytale format, including format type, block size, node limits, and feature support.",
  },
  {
    name: "hytale-attachments",
    uriTemplate: "hytale://attachments/{id}",
    title: "Hytale Attachments",
    description:
      "Returns information about attachment collections in the current Hytale project.",
  },
  {
    name: "hytale-pieces",
    uriTemplate: "hytale://pieces/{id}",
    title: "Hytale Attachment Pieces",
    description:
      "Returns information about groups marked as attachment pieces. Attachment pieces connect to like-named bones in the main model.",
  },
  {
    name: "hytale-cubes",
    uriTemplate: "hytale://cubes/{id}",
    title: "Hytale Cubes",
    description:
      "Returns information about cubes with Hytale-specific properties (shading_mode, double_sided, stretch).",
  },
];
