import type { ITrial, Model, Suite } from "./config";

/**
 * Conservative characters-per-token ratio for English prose and JSON. Real tokenizers
 * average closer to 4, so dividing by 3 overestimates tokens and keeps ceilings safe.
 */
export const charactersPerToken = 3;

/** Token counts for one prediction; `estimated` marks counts the provider did not report. */
export interface ITokenUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

/** Model reply text plus the tokens it was billed for. */
export interface IPredictionOutput {
  text: string;
  usage: ITokenUsage;
}

/** Running totals for one model; `costUsd` is null when the model has no pricing. */
export interface IModelSpend {
  model: string;
  predictions: number;
  estimatedPredictions: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** Worst-case spend for one model's share of a planned matrix. */
export interface IModelCeiling {
  model: string;
  trials: number;
  maxPredictions: number;
  ceilingUsd: number | null;
  /** Local agent CLIs use a subscription or local hardware, so they have no per-token ceiling. */
  local: boolean;
}

/** Thrown before a prediction whose worst-case cost would push total spend past `--max-cost`. */
export class CostCapReached extends Error {}

/** Upper-bound token count for text, using the conservative {@link charactersPerToken} ratio. */
export function estimateTokens(characters: number): number {
  return Math.ceil(characters / charactersPerToken);
}

/** USD cost of token usage at a model's per-million prices, or null for unpriced models. */
export function tokenCost(
  model: Model,
  usage: Pick<ITokenUsage, "inputTokens" | "outputTokens">,
): number | null {
  if (!model.pricing) return null;
  const { inputPerMillionUsd, outputPerMillionUsd } = model.pricing;
  return (
    (usage.inputTokens * inputPerMillionUsd +
      usage.outputTokens * outputPerMillionUsd) /
    1_000_000
  );
}

/** Worst-case tokens for one prediction: the whole prompt as input and the full output cap. */
function worstCaseUsage(
  promptCharacters: number,
  limits: Suite["limits"],
): ITokenUsage {
  return {
    inputTokens: estimateTokens(promptCharacters),
    outputTokens: limits.outputTokens,
    estimated: true,
  };
}

/**
 * Worst-case spend per model for a matrix: every trial uses all `predictionsPerTrial`
 * predictions, each at the full context-character cap and the full output-token cap.
 */
export function projectCeilings(
  suite: Suite,
  trials: readonly ITrial[],
): IModelCeiling[] {
  const perPrediction = worstCaseUsage(
    suite.limits.contextCharacters,
    suite.limits,
  );
  return suite.models.map((model) => {
    const count = trials.filter((trial) => trial.model.id === model.id).length;
    const maxPredictions = count * suite.limits.predictionsPerTrial;
    const unit = tokenCost(model, perPrediction);
    return {
      model: model.id,
      trials: count,
      maxPredictions,
      ceilingUsd: unit === null ? null : unit * maxPredictions,
      local: model.runner !== "replicate",
    };
  });
}

/** Human-readable ceiling table for the CLI; unpriced models are listed but excluded from the total. */
export function formatCeilings(
  ceilings: readonly IModelCeiling[],
  suite: Suite,
  capUsd: number | undefined,
): string {
  const dollars = (value: number): string => `$${value.toFixed(2)}`;
  const width = Math.max(...ceilings.map((row) => row.model.length));
  const lines = ceilings.map(
    (row) =>
      `  ${row.model.padEnd(width)}  ${String(row.trials).padStart(3)} trials  ${row.local ? "local CLI, not billed per token" : row.ceilingUsd === null ? "unpriced" : dollars(row.ceilingUsd)}`,
  );
  const total = ceilings.reduce((sum, row) => sum + (row.ceilingUsd ?? 0), 0);
  const unpriced = ceilings
    .filter((row) => row.ceilingUsd === null && !row.local)
    .map((row) => row.model);
  return [
    `Cost ceiling (every trial uses all ${suite.limits.predictionsPerTrial} predictions at the ${suite.limits.contextCharacters}-character context cap and ${suite.limits.outputTokens} output tokens; ~${charactersPerToken} chars/token):`,
    ...lines,
    `  total${unpriced.length ? " (priced models only)" : ""}: ${dollars(total)}`,
    ...(unpriced.length
      ? [`  No pricing in the suite for: ${unpriced.join(", ")}`]
      : []),
    ...(capUsd === undefined
      ? []
      : [
          unpriced.length
            ? `  --max-cost ${dollars(capUsd)}: a live run would refuse to start until every selected model has pricing.`
            : `  --max-cost ${dollars(capUsd)}: a live run stops before any prediction that could exceed it.`,
        ]),
  ].join("\n");
}

/**
 * Tracks spend across a run and enforces an optional USD cap. Every prediction is
 * checked against its own worst case first, so the cap holds even if the reply is long.
 */
export class CostLedger {
  private totals: ReadonlyMap<string, IModelSpend>;

  /** A cap requires pricing for every model, since unpriced spend could not be bounded. */
  constructor(
    models: readonly Model[],
    private readonly limits: Suite["limits"],
    readonly capUsd: number | undefined,
  ) {
    const unpriced = models
      .filter((model) => !model.pricing)
      .map((model) => model.id);
    if (capUsd !== undefined && unpriced.length) {
      throw new Error(
        `--max-cost needs pricing in the suite for: ${unpriced.join(", ")}`,
      );
    }
    this.totals = new Map(
      models.map((model) => [
        model.id,
        {
          model: model.id,
          predictions: 0,
          estimatedPredictions: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: model.pricing ? 0 : null,
        },
      ]),
    );
  }

  /** Total USD spent on priced models so far. */
  get spentUsd(): number {
    return [...this.totals.values()].reduce(
      (sum, spend) => sum + (spend.costUsd ?? 0),
      0,
    );
  }

  /** Per-model totals, for `costs.json` and the summary table. */
  snapshot(): {
    capUsd: number | null;
    spentUsd: number;
    models: IModelSpend[];
  } {
    return {
      capUsd: this.capUsd ?? null,
      spentUsd: this.spentUsd,
      models: [...this.totals.values()],
    };
  }

  /** Current totals for one model. */
  spendFor(model: Model): IModelSpend | undefined {
    return this.totals.get(model.id);
  }

  /**
   * Runs one prediction if its worst case fits under the cap, then records what it used.
   * A failed prediction is charged its worst case, since it may still have been billed.
   */
  async charge(
    model: Model,
    prompt: string,
    predict: () => Promise<IPredictionOutput>,
  ): Promise<string> {
    const worst = worstCaseUsage(prompt.length, this.limits);
    const worstUsd = tokenCost(model, worst) ?? 0;
    if (this.capUsd !== undefined && this.spentUsd + worstUsd > this.capUsd) {
      throw new CostCapReached(
        `Cost cap $${this.capUsd.toFixed(2)} reached: spent $${this.spentUsd.toFixed(2)}, next prediction could cost up to $${worstUsd.toFixed(2)}.`,
      );
    }
    try {
      const output = await predict();
      this.record(model, output.usage);
      return output.text;
    } catch (error) {
      this.record(model, worst);
      throw error;
    }
  }

  private record(model: Model, usage: ITokenUsage): void {
    const current = this.totals.get(model.id);
    if (!current) throw new Error(`Model ${model.id} is not part of this run.`);
    const cost = tokenCost(model, usage);
    this.totals = new Map(this.totals).set(model.id, {
      ...current,
      predictions: current.predictions + 1,
      estimatedPredictions:
        current.estimatedPredictions + (usage.estimated ? 1 : 0),
      inputTokens: current.inputTokens + usage.inputTokens,
      outputTokens: current.outputTokens + usage.outputTokens,
      costUsd:
        current.costUsd === null || cost === null
          ? null
          : current.costUsd + cost,
    });
  }
}
