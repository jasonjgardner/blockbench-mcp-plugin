/**
 * Validation tools: geometry gates, animation gates, and GeckoLib rules.
 *
 * @module
 */

import { z } from "zod";
import { GECKOLIB_FORMAT_ID, GECKOLIB_MODEL_TYPE_PROPERTY, GECKOLIB_MODID_PROPERTY } from "@/lib/geckolib";
import { summarizeDiagnostics, validateGeckolibProject } from "@/lib/geckolib-validate";
import type { IBBModel } from "../document/schema";
import { runAnimationGates } from "../gates/animation";
import { type BlockLimitMode, GEOMETRY_GATE_IDS, runGeometryGates } from "../gates/geometry";
import { selfTestGeometryGates } from "../gates/inject";
import { summarizeGates } from "../gates/types";
import { defineTool, fileParam, type IRegistrableTool } from "../tool";

/** Block-size rule enforced by default for block formats. */
const DEFAULT_BLOCK_LIMITS: Readonly<Record<string, BlockLimitMode>> = { java_block: "java_block", bedrock_block: "bedrock_block" };

/** GeckoLib project facts gathered from the file instead of the live project. */
function geckolibDiagnostics(doc: IBBModel) {
  const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
  const diagnostics = validateGeckolibProject({
    boneNames: doc.groups.map((group) => group.name),
    modid: text(doc[GECKOLIB_MODID_PROPERTY]),
    identifier: text(doc.model_identifier),
    modelType: text(doc[GECKOLIB_MODEL_TYPE_PROPERTY]),
    declaredTextureSize: { width: doc.resolution.width, height: doc.resolution.height },
    textureSizes: doc.textures.flatMap((texture) =>
      typeof texture.width === "number" && typeof texture.height === "number" ? [{ name: texture.name, width: texture.width, height: texture.height }] : [],
    ),
  });
  return { diagnostics, summary: summarizeDiagnostics(diagnostics) };
}

const validateTool = defineTool({
  name: "bbmodel_validate",
  title: "Validate Model",
  description: [
    "Runs geometry gates on a .bbmodel file in its rest pose and reports every violation by node name.",
    "Gates: outliner (broken references, duplicate UUIDs), unlisted_nodes, degenerate (slivers, inverted cubes), block_limits (Java or Bedrock block size), floating (parts touching nothing in the main body), interpenetration (deep overlaps across groups), mirror (left/right parts that are not mirror images).",
    "self_test plants each gate's defect into a copy and confirms the gate catches it; a gate that does not discriminate on this model should not be trusted.",
    "GeckoLib rules run automatically for geckolib_model files.",
  ].join(" "),
  parameters: {
    file: fileParam,
    gates: z.array(z.enum(GEOMETRY_GATE_IDS)).optional().describe("Defaults to all gates."),
    block_limits: z.enum(["none", "java_block", "bedrock_block"]).optional().describe("Defaults to java_block for java_block models, bedrock_block for bedrock_block models, otherwise none."),
    free_elements: z.array(z.string()).default([]).describe("Element names allowed to float (deliberately detached parts)."),
    asymmetric: z.array(z.string()).default([]).describe("Group or element names excluded from the mirror gate."),
    mirror_x: z.number().optional().describe("X of the symmetry plane; defaults to 8 for java_block and 0 otherwise."),
    min_thickness: z.number().positive().default(0.2),
    allow_planes: z.boolean().default(true).describe("Zero-thickness planes are intentional (leaves, decals)."),
    interpenetration_depth: z.number().positive().default(0.55),
    material_key: z.enum(["none", "color", "texture"]).default("none").describe("Exempt overlapping parts that share this material key."),
    self_test: z.boolean().default(false),
    geckolib: z.boolean().optional().describe("Force GeckoLib rules on or off."),
  },
  readOnly: true,
  async execute(args, { store }) {
    const { doc, revision, notes } = await store.read(args.file);
    const format = doc.meta.model_format;
    const blockLimits = args.block_limits ?? DEFAULT_BLOCK_LIMITS[format] ?? "none";
    const options = {
      blockLimits,
      freeElements: args.free_elements,
      asymmetric: args.asymmetric,
      mirrorX: args.mirror_x,
      minThickness: args.min_thickness,
      allowPlanes: args.allow_planes,
      interpenetrationDepth: args.interpenetration_depth,
      materialKey: args.material_key,
    } as const;
    const gates = args.gates ?? [...GEOMETRY_GATE_IDS];
    const results = runGeometryGates(doc, options, gates);
    const selfTest = args.self_test ? selfTestGeometryGates(doc, options, gates) : undefined;
    const runGeckolib = args.geckolib ?? format === GECKOLIB_FORMAT_ID;
    return {
      revision,
      format,
      summary: summarizeGates(results),
      gates: results,
      ...(selfTest ? { self_test: selfTest } : {}),
      ...(runGeckolib ? { geckolib: geckolibDiagnostics(doc) } : {}),
      notes,
    };
  },
});

const validateAnimationsTool = defineTool({
  name: "bbmodel_validate_animations",
  title: "Validate Animations",
  description: [
    "Checks animation clips by sampling them densely and measuring the posed geometry.",
    "Gates: animated_bones_exist, keyframe_timing (out-of-range or colliding keys), ground_sink (parts dipping below the rest pose's lowest point), detachment (groups separating from the parent group they touch at rest).",
    "Bezier keys are sampled linearly and Molang expressions other than plain numbers are skipped; both are listed in the result.",
  ].join(" "),
  parameters: {
    file: fileParam,
    animations: z.array(z.string()).default([]).describe("Clip names or UUIDs; defaults to all."),
    sample_rate: z.number().min(1).max(240).default(20).describe("Samples per second."),
    sink_tolerance: z.number().min(0).default(0.5),
    ground_y: z.number().optional().describe("Ground height; defaults to the lowest point of the rest pose."),
    detach_gap: z.number().min(0).default(1),
  },
  readOnly: true,
  async execute(args, { store }) {
    const { doc, revision } = await store.read(args.file);
    const report = runAnimationGates(doc, {
      animations: args.animations,
      sampleRate: args.sample_rate,
      sinkTolerance: args.sink_tolerance,
      groundY: args.ground_y,
      detachGap: args.detach_gap,
    });
    return {
      revision,
      checked: report.checked,
      summary: summarizeGates(report.results),
      gates: report.results,
      skipped_channels: report.sampling.skippedChannels,
      approximated_bezier: report.sampling.approximatedBezier,
      capped_clips: report.sampling.cappedClips,
    };
  },
});

/** Validation tools. */
export const validateTools: readonly IRegistrableTool[] = [validateTool, validateAnimationsTool];
