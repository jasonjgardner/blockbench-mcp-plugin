import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const vector = z.tuple([z.number(), z.number(), z.number()]);

/** A portable trial definition; fixture cubes are applied identically for every model. */
export const caseSchema = z
  .object({
    id,
    title: z.string(),
    format: z.string(),
    brief: z.string(),
    acceptance: z.array(z.string()).min(1),
    animation: z.boolean(),
    fixture: z
      .array(z.object({ name: z.string(), from: vector, to: vector }).strict())
      .min(1),
  })
  .strict();

/**
 * Replicate per-token prices in USD, with where and when they were read. Prices drift,
 * so the source and date are archived with every run manifest.
 */
export const pricingSchema = z
  .object({
    inputPerMillionUsd: z.number().nonnegative(),
    outputPerMillionUsd: z.number().nonnegative(),
    source: z.string().url(),
    checkedAt: z.string().date(),
  })
  .strict();

/** Model registry entry; aliases are resolved and schemas archived before paid execution. */
export const modelSchema = z
  .object({
    id,
    provider: z.enum([
      "OpenAI",
      "Anthropic",
      "Google",
      "Meta",
      "Qwen",
      "DeepSeek AI",
      "Moonshot AI",
    ]),
    /**
     * Replicate: `owner/name`. CLI runners: the name the CLI's model flag takes, or
     * `default` to use the CLI's configured default (the reported model is recorded).
     */
    model: z.string().min(1),
    version: z.string().min(1).optional(),
    source: z.string().url(),
    pricing: pricingSchema.optional(),
    /** How the model is driven: Replicate predictions, or a local agent CLI. */
    runner: z
      .enum(["replicate", "claude", "codex", "gemini"])
      .default("replicate"),
    /** Runs a Claude Code agent on a local Ollama model instead of an Anthropic account. */
    backend: z.literal("ollama").optional(),
  })
  .strict()
  .superRefine((model, ctx) => {
    if (
      model.runner === "replicate" &&
      !/^[\w.-]+\/[\w.-]+$/.test(model.model)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Replicate models must be owner/name.",
      });
    }
    if (model.backend === "ollama" && model.runner !== "claude") {
      ctx.addIssue({
        code: "custom",
        message: "The ollama backend runs through the claude runner.",
      });
    }
  });

/** Common budgets include all subagent predictions, preventing hidden extra computation. */
export const suiteSchema = z
  .object({
    version: z.literal(1),
    models: z.array(modelSchema).min(1),
    cases: z.array(caseSchema).min(1),
    conditions: z.array(z.enum(["empty", "scaffold", "repair"])).min(1),
    repetitions: z.number().int().min(1).max(100),
    /** Default spend cap for live runs; `--max-cost` can lower it but never raise it. */
    maxCostUsd: z.number().positive().optional(),
    limits: z
      .object({
        turnsPerStage: z.number().int().min(1).max(500),
        predictionsPerTrial: z.number().int().min(1).max(2000),
        reviewerTurns: z.number().int().min(1).max(100),
        outputTokens: z.number().int().min(256).max(32768),
        predictionTimeoutMs: z.number().int().min(1000),
        trialTimeoutMs: z.number().int().min(1000),
        contextCharacters: z.number().int().min(1000),
        observationCharacters: z.number().int().min(1000),
        /**
         * Minimum gap between Replicate API requests. 0 relies on 429 recovery alone;
         * 1000 stays under the 60-per-minute limit of the most restricted accounts'
         * burst tier. Throttled requests are always waited out and retried.
         */
        minRequestIntervalMs: z.number().int().min(0).max(60_000).default(0),
        /** Wall-clock limit for one CLI agent stage; the process tree is killed at the limit. */
        stageTimeoutMs: z.number().int().min(10_000).default(900_000),
        /**
         * CLI track only: tool calls allowed per stage through the proxy. 0 means no
         * limit, leaving `stageTimeoutMs` as the only stop for a runaway agent.
         */
        toolCallsPerStage: z.number().int().min(0).default(0),
      })
      .strict(),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const hasDuplicates = (ids: readonly string[]): boolean =>
      new Set(ids).size !== ids.length;
    [suite.models, suite.cases]
      .filter((items) => hasDuplicates(items.map((item) => item.id)))
      .forEach(() =>
        ctx.addIssue({
          code: "custom",
          message: "Duplicate registry IDs are not allowed.",
        }),
      );
    if (hasDuplicates(suite.conditions)) {
      ctx.addIssue({
        code: "custom",
        message: "Duplicate conditions are not allowed.",
      });
    }
  });

/** Validated suite configuration, with common limits and the complete model/case matrix. */
export type Suite = z.infer<typeof suiteSchema>;
/** One model identity in the Replicate registry. */
export type Model = z.infer<typeof modelSchema>;
/** One asset task, its format, deterministic fixture, and quality expectations. */
export type AssetCase = z.infer<typeof caseSchema>;
/** Starting project state, crossed with every selected model and case. */
export type Condition = Suite["conditions"][number];
/** A single isolated benchmark attempt, including its repetition number. */
export interface ITrial {
  id: string;
  model: Model;
  asset: AssetCase;
  condition: Condition;
  repetition: number;
}

/** Produces a deterministic case-first matrix; execution must await each cell in order. */
export function matrix(suite: Suite): ITrial[] {
  const repetitions = Array.from(
    { length: suite.repetitions },
    (_, index) => index + 1,
  );
  return suite.cases.flatMap((asset) =>
    suite.conditions.flatMap((condition) =>
      repetitions.flatMap((repetition) =>
        suite.models.map((model) => ({
          id: `${asset.id}--${condition}--${model.id}--r${repetition}`,
          model,
          asset,
          condition,
          repetition,
        })),
      ),
    ),
  );
}

/** Awaits work one item at a time; a rejection stops the sequence instead of overlapping work. */
export async function sequential<T, R>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return items.reduce<Promise<R[]>>(
    async (previous, item, index) => [
      ...(await previous),
      await work(item, index),
    ],
    Promise.resolve([]),
  );
}
