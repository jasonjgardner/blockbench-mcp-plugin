import { z } from "zod";
import type { AssetCase } from "./config";

const modelSchema = z
  .object({
    elements: z
      .array(
        z
          .object({
            type: z.string().optional(),
            faces: z.record(z.unknown()).optional(),
          })
          .passthrough(),
      )
      .default([]),
    textures: z.array(z.unknown()).default([]),
    animations: z
      .array(
        z
          .object({
            name: z.string(),
            uuid: z.string().optional(),
            length: z.number().optional(),
            loop: z.string().optional(),
            animators: z.record(z.unknown()).optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

/** Structural counts from a `.bbmodel`; evidence for reviewers, never a quality score. */
export interface IModelMetrics {
  elements: number;
  cubes: number;
  meshes: number;
  faces: number;
  textures: number;
  animations: {
    name: string;
    id: string;
    length: number;
    loop: string;
    animators: number;
  }[];
}

/** Human-review rubric dimensions; animated cases add rig and timing dimensions. */
export function reviewDimensions(animation: boolean): string[] {
  return [
    "silhouette_and_proportions",
    "geometry_and_structure",
    "texture_and_uv",
    "brief_compliance",
    "delivery_and_editability",
    ...(animation ? ["rig_and_motion", "timing_and_loop"] : []),
  ];
}

/** Extracts structural evidence only; counts deliberately never become a visual-quality score. */
export function measureModel(raw: unknown): IModelMetrics {
  const model = modelSchema.parse(raw);
  return {
    elements: model.elements.length,
    cubes: model.elements.filter(
      (element) => element.type === "cube" || !element.type,
    ).length,
    meshes: model.elements.filter((element) => element.type === "mesh").length,
    faces: model.elements.reduce(
      (count, element) => count + Object.keys(element.faces ?? {}).length,
      0,
    ),
    textures: model.textures.length,
    animations: model.animations.map((animation) => ({
      name: animation.name,
      id: animation.uuid ?? animation.name,
      length: animation.length ?? 0,
      loop: animation.loop ?? "unknown",
      animators: Object.keys(animation.animators ?? {}).length,
    })),
  };
}

/** Creates a human-review form with nullable scores, making unreviewed results unmistakable. */
export function reviewTemplate(asset: AssetCase): unknown {
  return {
    status: "unreviewed",
    reviewer: null,
    reviewedAt: null,
    scale:
      "0 missing/unusable; 1 major defects; 2 recognizable with substantial defects; 3 meets brief with minor defects; 4 polished and convincing",
    dimensions: Object.fromEntries(
      reviewDimensions(asset.animation).map((name) => [
        name,
        { score: null, evidence: [], notes: "" },
      ]),
    ),
    acceptance: asset.acceptance.map((criterion) => ({
      criterion,
      met: null,
      evidence: [],
      notes: "",
    })),
    notes:
      "Review archived multi-view and animation evidence, then inspect the .bbmodel. Self-review is not an independent score. Compare blind to provider when possible.",
  };
}
