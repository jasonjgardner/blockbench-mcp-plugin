import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { reviewDimensions } from "./assessment";
import { sequential } from "./config";
import { Evidence, errorText } from "./evidence";

const reviewSchema = z.object({
  status: z.literal("reviewed"),
  reviewer: z.string().trim().min(1),
  reviewedAt: z.string().datetime(),
  dimensions: z.record(
    z.object({
      score: z.number().int().min(0).max(4),
      evidence: z.array(z.string().min(1)).min(1),
      notes: z.string(),
    }),
  ),
  acceptance: z
    .array(
      z.object({
        criterion: z.string(),
        met: z.boolean(),
        evidence: z.array(z.string()).min(1),
        notes: z.string(),
      }),
    )
    .min(1),
});
const planSchema = z.array(
  z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    model: z.object({ id: z.string() }),
    asset: z.object({
      id: z.string(),
      animation: z.boolean(),
      acceptance: z.array(z.string()),
    }),
    condition: z.string(),
    repetition: z.number(),
  }),
);
const summarySchema = z.array(
  z.object({ id: z.string(), status: z.string() }).passthrough(),
);

/** Returns a human score only for a complete, attributed review; unreviewed templates stay null. */
export function reviewedScore(
  raw: unknown,
  expectedDimensions: readonly string[],
  expectedCriteria: readonly string[],
): number | null {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "status" in raw &&
    raw.status === "unreviewed"
  )
    return null;
  const review = reviewSchema.parse(raw);
  const dimensions = Object.keys(review.dimensions);
  if (
    dimensions.length !== expectedDimensions.length ||
    !expectedDimensions.every((key) => dimensions.includes(key))
  ) {
    throw new Error("Review dimensions do not match this case.");
  }
  if (
    review.acceptance.length !== expectedCriteria.length ||
    review.acceptance.some(
      (item, index) => item.criterion !== expectedCriteria[index],
    )
  ) {
    throw new Error("Review acceptance criteria do not match this case.");
  }
  if (!dimensions.length) throw new Error("Empty review dimensions.");
  return (
    Object.values(review.dimensions).reduce(
      (sum, dimension) => sum + dimension.score,
      0,
    ) / dimensions.length
  );
}

/** Regenerates a per-trial quality table from human reviews without modifying original result evidence. */
export async function qualityReport(directory: string): Promise<void> {
  const resultsRoot = resolve(import.meta.dir, "results");
  const root = resolve(directory);
  const inside = relative(resultsRoot, root);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error("Choose a run directory inside benchmarks/results.");
  }
  const plan = planSchema.parse(
    await Bun.file(resolve(root, "plan.json")).json(),
  );
  const summary = summarySchema.parse(
    await Bun.file(resolve(root, "summary.json")).json(),
  );
  const rows = await sequential(plan, async (trial) => {
    const reviewFile = Bun.file(
      resolve(root, "trials", trial.id, "review.json"),
    );
    const dimensions = reviewDimensions(trial.asset.animation);
    const score = (await reviewFile.exists())
      ? reviewedScore(
          await reviewFile.json(),
          dimensions,
          trial.asset.acceptance,
        )
      : null;
    return {
      id: trial.id,
      model: trial.model.id,
      case: trial.asset.id,
      condition: trial.condition,
      repetition: trial.repetition,
      status: summary.find((item) => item.id === trial.id)?.status ?? "missing",
      score,
    };
  });
  const evidence = new Evidence(root);
  await evidence.json("quality.json", rows);
  const table = rows.map(
    (row) =>
      `| ${row.id} | ${row.status} | ${row.score?.toFixed(2) ?? "unreviewed"} |`,
  );
  await evidence.text(
    "quality.md",
    `# Human quality reviews\n\nScores are means on a 0–4 scale. Unreviewed and unavailable attempts remain unscored. Compare matching case/condition/repetition and report coverage; do not rank models from unequal subsets.\n\n| Trial | Execution | Human score / 4 |\n|---|---|---:|\n${table.join("\n")}\n`,
  );
}

if (import.meta.main) {
  try {
    const directory = Bun.argv[2];
    if (!directory)
      throw new Error(
        "Usage: bun run benchmark:report benchmarks/results/<run-directory>",
      );
    await qualityReport(directory);
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  }
}
