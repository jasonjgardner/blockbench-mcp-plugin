import type { Condition, ITrial } from "./config";

/** Starting-state instructions; identical wording for every model under the same condition. */
const conditions: Readonly<Record<Condition, string>> = {
  empty: "The project is empty. Build the requested asset.",
  scaffold:
    "The project contains named coarse blockout cubes. Inspect them, preserve useful proportions, and refine or replace them as needed.",
  repair:
    "The project contains a damaged blockout: the second part is offset four units upward and six sideways. Inspect and correct alignment before completing the asset. You may replace coarse geometry.",
};

/** Builds the same four-stage sequence for a case/condition, independent of model identity. */
export function prompts(trial: ITrial): string[] {
  const { asset } = trial;
  const acceptance = asset.acceptance.map((item) => `- ${item}`).join("\n");
  const brief = `Task: ${asset.title}\n${asset.brief}\nTarget format: ${asset.format}.\n${conditions[trial.condition]}\nAcceptance criteria:\n${acceptance}`;
  return [
    `${brief}\nStage 1 of 4 — Inspect capabilities and the project, read relevant guidance, then build the complete geometry and named hierarchy. Establish silhouette and proportions before materials. Use the physical-accuracy reviewer if available to check structure. Finish with a short account of what exists and what remains.`,
    "Stage 2 of 4 — Complete materials, textures and UVs using the original brief. Read texturing guidance, verify face proportions and effective texel density, and repair visible mapping problems. Capture evidence. Preserve successful geometry.",
    asset.animation
      ? "Stage 3 of 4 — Rig and animate the requested motion. Read animation guidance. Verify pivots, keyframes, timing, multiple poses and the loop seam. Capture pose evidence. Preserve geometry and materials."
      : "Stage 3 of 4 — Inspect silhouette, topology, unsupported or intersecting parts, and UV consistency. Use the physical-accuracy reviewer if available, then apply justified corrections. Capture evidence and preserve successful work.",
    "Stage 4 of 4 — Audit every original acceptance criterion. Correct remaining problems within the budget. Discover and compile the intended runtime export with embedded content and without a filesystem path. The harness will save the editable project and standardized screenshots. Report verified outcomes, deliberate deviations and unresolved limitations honestly. Do not assign yourself a quality score.",
  ];
}
