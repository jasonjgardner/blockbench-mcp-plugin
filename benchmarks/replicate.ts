import Replicate, { type Prediction } from "replicate";
import { z } from "zod";
import type { Model, Suite } from "./config";
import {
  estimateTokens,
  type IPredictionOutput,
  type ITokenUsage,
} from "./cost";
import type { Evidence } from "./evidence";
import {
  pause,
  RateLimited,
  RequestSpacer,
  withThrottleRetry,
} from "./ratelimit";

/** Token counts Replicate reports for official language models; either may be absent. */
const metricsSchema = z
  .object({
    input_token_count: z.number().int().nonnegative(),
    output_token_count: z.number().int().nonnegative(),
    // Replicate's billing metric names, accepted in case metrics use them instead.
    token_input_count: z.number().int().nonnegative(),
    token_output_count: z.number().int().nonnegative(),
  })
  .partial()
  .passthrough();

/**
 * Billed tokens from Replicate's prediction metrics. A missing count falls back to a
 * conservative estimate: the prompt at ~3 chars/token, or the full output cap, since
 * hidden reasoning tokens can be billed without appearing in the reply text.
 */
export function tokenUsage(
  metrics: unknown,
  prompt: string,
  outputTokens: number,
): ITokenUsage {
  const parsed = metricsSchema.safeParse(metrics ?? {});
  const reported = parsed.success ? parsed.data : {};
  const input = reported.input_token_count ?? reported.token_input_count;
  const output = reported.output_token_count ?? reported.token_output_count;
  return {
    inputTokens: input ?? estimateTokens(prompt.length),
    outputTokens: output ?? outputTokens,
    estimated: input === undefined || output === undefined,
  };
}

/** Deadline for each HTTP exchange with the Replicate API. */
const requestTimeoutMs = 60_000;
/**
 * Deadline for confirming a cancellation before the run is declared uncertain.
 * Long enough to wait out one throttle reset (~30s) and retry.
 */
const cancelTimeoutMs = 90_000;
/** Deadline for resolving model metadata, including any throttle waits. */
const resolveTimeoutMs = 300_000;
/**
 * Seconds Replicate may hold a create request open until the prediction finishes
 * (`Prefer: wait`). Most replies then need no polling at all. Kept well under
 * {@link requestTimeoutMs}, because a create that times out client-side is uncertain.
 */
const syncWaitSeconds = 30;
/** First and longest delay between status polls; polling backs off in between. */
const pollBaseMs = 1000;
const pollMaxMs = 8000;
/** Output-cap input names used by Replicate language models, in preference order. */
const tokenKeys = [
  "max_output_tokens",
  "max_tokens",
  "max_new_tokens",
  // OpenAI models on Replicate; for reasoning models this cap also covers hidden reasoning tokens.
  "max_completion_tokens",
] as const;

const propertySchema = z
  .object({
    type: z.string().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.unknown().optional(),
  })
  .passthrough();
const inputSchema = z
  .object({
    components: z
      .object({
        schemas: z
          .object({
            Input: z
              .object({
                properties: z.record(propertySchema),
                required: z.array(z.string()).optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/** Resolved model metadata and the schema-supported generation parameters archived during preflight. */
export interface IResolvedModel {
  model: Model;
  schemaVersion: string;
  official: boolean;
  schema: unknown;
  parameters: Record<string, unknown>;
}

/** A request may still be running remotely; stop the matrix until the operator checks Replicate. */
export class PredictionUncertain extends Error {}

/** True while Replicate may still be computing (and billing) a prediction. */
function isRunning(status: string): boolean {
  return status === "starting" || status === "processing";
}

/** True when the API explicitly refused the request, so no prediction can exist remotely. */
function rejectedByApi(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("response" in error))
    return false;
  const { response } = error;
  return (
    response instanceof Response &&
    response.status >= 400 &&
    response.status < 500
  );
}

/** Adapts output caps to a live schema; unsupported or incompatible endpoints fail before prediction. */
export function generationParameters(
  schema: unknown,
  outputTokens: number,
): Record<string, unknown> {
  const input = inputSchema.parse(schema).components.schemas.Input;
  if (input.properties.prompt?.type !== "string")
    throw new Error("Endpoint does not expose a string prompt input.");
  const tokenKey = tokenKeys.find((key) => input.properties[key]);
  const token = tokenKey && input.properties[tokenKey];
  if (!tokenKey || !token)
    throw new Error(
      "Endpoint has no supported output-token limit; add an explicit adapter.",
    );
  if (
    (token.minimum !== undefined && outputTokens < token.minimum) ||
    (token.maximum !== undefined && outputTokens > token.maximum)
  ) {
    throw new Error(
      "Requested common output budget is outside this endpoint's schema range.",
    );
  }
  const temperature = input.properties.temperature;
  const parameters: Record<string, unknown> = {
    [tokenKey]: outputTokens,
    ...(temperature
      ? { temperature: Math.max(temperature.minimum ?? 0, 0) }
      : {}),
  };
  const missing = (input.required ?? []).filter(
    (key) =>
      key !== "prompt" &&
      !(key in parameters) &&
      input.properties[key]?.default === undefined,
  );
  if (missing.length)
    throw new Error(`Unsupported required inputs: ${missing.join(", ")}`);
  return parameters;
}

/** Accepts the two documented text output shapes; never stringifies objects into fake model replies. */
export function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (
    Array.isArray(output) &&
    output.every((item): item is string => typeof item === "string")
  )
    return output.join("");
  throw new Error("Unsupported Replicate text output shape.");
}

/** Uses the installed official Node.js SDK; no provider-specific API clients or secret-bearing traces. */
export class ReplicateProvider {
  private readonly sdk: Replicate;

  /**
   * Requests have a transport deadline. A prediction is only created again after
   * Replicate answered 429, which proves the earlier attempt created nothing.
   * `minRequestIntervalMs` spaces every outgoing request to stay under a rate limit.
   */
  constructor(
    token: string,
    transport: (
      input: Request | string | URL,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
    { minRequestIntervalMs = 0 }: { minRequestIntervalMs?: number } = {},
  ) {
    const spacer = new RequestSpacer(minRequestIntervalMs);
    // Replicate 1.4 retries even rejected fetch promises. Memoize each logical SDK
    // request's transport promise by its stable init object, so internal retries
    // can never create a second billable prediction. Return clones for body reuse.
    const requests = new WeakMap<RequestInit, Promise<Response>>();
    this.sdk = new Replicate({
      auth: token,
      useFileOutput: false,
      fetch: (input, init) => {
        const key = init ?? {};
        const existing = requests.get(key);
        if (existing) return existing.then((response) => response.clone());
        const deadline = AbortSignal.timeout(requestTimeoutMs);
        const signal = init?.signal
          ? AbortSignal.any([init.signal, deadline])
          : deadline;
        const request = spacer
          .reserve(signal)
          .then(() => transport(input, { ...init, signal }));
        requests.set(key, request);
        return request.then((response) => response.clone());
      },
    });
  }

  /** Resolves availability and schema without starting billable inference. */
  async resolve(model: Model, outputTokens: number): Promise<IResolvedModel> {
    const [owner, name] = model.model.split("/");
    if (!owner || !name) throw new Error("Invalid model identifier.");
    const throttle = {
      operation: `resolve ${model.model}`,
      signal: AbortSignal.timeout(resolveTimeoutMs),
    };
    const metadata = await withThrottleRetry(
      () => this.sdk.models.get(owner, name),
      throttle,
    );
    const pinned = model.version;
    const version = pinned
      ? await withThrottleRetry(
          () => this.sdk.models.versions.get(owner, name, pinned),
          throttle,
        )
      : metadata.latest_version;
    if (!version?.openapi_schema)
      throw new Error(`No input schema available for ${model.model}.`);
    return {
      model,
      official: metadata.is_official,
      schemaVersion: version.id,
      schema: version.openapi_schema,
      parameters: generationParameters(version.openapi_schema, outputTokens),
    };
  }

  /** Runs one bounded prediction, archives its inputs, ID, output and metrics, and reports billed tokens. */
  async predict(
    resolved: IResolvedModel,
    prompt: string,
    limits: Suite["limits"],
    evidence: Evidence,
    signal: AbortSignal,
  ): Promise<IPredictionOutput> {
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(limits.predictionTimeoutMs),
    ]);
    const input = { ...resolved.parameters, prompt };
    await evidence.event("prediction-request", {
      model: resolved.model.model,
      input,
    });
    deadline.throwIfAborted();
    const onThrottle = (notice: object): Promise<void> =>
      evidence.event("rate-limited", notice);
    // Tracks the latest known remote state so a failure can cancel whatever is still running.
    let prediction: Prediction | undefined;
    const poll = async (
      current: Prediction,
      attempt = 0,
    ): Promise<Prediction> => {
      deadline.throwIfAborted();
      if (!isRunning(current.status)) return current;
      await pause(Math.min(pollBaseMs * 2 ** attempt, pollMaxMs), deadline);
      prediction = await withThrottleRetry(
        () => this.sdk.predictions.get(current.id, { signal: deadline }),
        { operation: "poll", signal: deadline, onThrottle },
      );
      return poll(prediction, attempt + 1);
    };
    try {
      const version =
        resolved.model.version ??
        (resolved.official ? undefined : resolved.schemaVersion);
      prediction = await withThrottleRetry(
        () =>
          this.sdk.predictions.create({
            ...(version ? { version } : { model: resolved.model.model }),
            input,
            wait: syncWaitSeconds,
            signal: deadline,
          }),
        { operation: "create", signal: deadline, onThrottle },
      );
      await evidence.event("prediction-created", {
        id: prediction.id,
        version: prediction.version,
        status: prediction.status,
      });
      const final = await poll(prediction);
      await evidence.event("prediction-result", {
        id: final.id,
        model: final.model,
        version: final.version,
        status: final.status,
        output: final.output as unknown,
        error: final.error,
        metrics: final.metrics,
        createdAt: final.created_at,
        completedAt: final.completed_at,
      });
      if (final.status !== "succeeded")
        throw new Error(`Prediction ${final.id} ended ${final.status}.`);
      return {
        text: outputText(final.output as unknown),
        usage: tokenUsage(final.metrics, prompt, limits.outputTokens),
      };
    } catch (error) {
      // A 429 or an interrupted throttle wait leaves nothing in flight; any other
      // failure before a prediction ID arrives may have created one remotely.
      if (
        !prediction &&
        !rejectedByApi(error) &&
        !(error instanceof RateLimited)
      ) {
        throw new PredictionUncertain(
          "Prediction creation was not confirmed. Inspect Replicate before another run; the request was not resent.",
        );
      }
      if (prediction && isRunning(prediction.status))
        await this.cancel(prediction.id, evidence);
      throw error;
    }
  }

  /** Cancels a running prediction; anything short of a confirmed terminal state stops the matrix. */
  private async cancel(id: string, evidence: Evidence): Promise<void> {
    try {
      const signal = AbortSignal.timeout(cancelTimeoutMs);
      const canceled = await withThrottleRetry(
        () => this.sdk.predictions.cancel(id, { signal }),
        {
          operation: "cancel",
          signal,
          onThrottle: (notice) => evidence.event("rate-limited", notice),
        },
      );
      await evidence.event("prediction-cancel", {
        id,
        status: canceled.status,
      });
      if (isRunning(canceled.status))
        throw new Error("Cancellation did not confirm a terminal state.");
    } catch {
      await evidence.event("prediction-cancel-unconfirmed", { id });
      throw new PredictionUncertain(
        `Cancellation unconfirmed for ${id}. Inspect Replicate before another run.`,
      );
    }
  }
}
