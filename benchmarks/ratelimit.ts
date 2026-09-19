/**
 * Replicate throttling support. Replicate answers throttled requests with HTTP 429
 * and a body like `{"detail":"... resets in ~30s."}`; low-credit accounts can be
 * limited to 6 requests per minute. The Replicate SDK's own retries fire almost
 * immediately, so the harness waits for the reset itself and spaces its requests.
 */

/** Backoff when a 429 carries no reset hint: 2s, 4s, 8s, ... */
const fallbackBaseMs = 2000;
/** Longest single wait; Replicate's reset hints are normally around 30 seconds. */
const maxWaitMs = 120_000;
/** Attempts per operation, including the first, before the run stops as rate-limited. */
export const maxThrottleAttempts = 6;

/**
 * No request was left in flight: Replicate refused every attempt with 429, or the
 * wait for its reset was interrupted. Unlike a lost connection, this never leaves
 * an unconfirmed prediction behind, so it stops the run without an uncertain state.
 */
export class RateLimited extends Error {}

/** Details of one throttled attempt, for the evidence trace. */
export interface IThrottleNotice {
  operation: string;
  attempt: number;
  waitMs: number;
}

/** Options for {@link withThrottleRetry}. */
export interface IThrottleOptions {
  /** Label recorded with each throttle notice, such as `create` or `poll`. */
  operation: string;
  signal: AbortSignal;
  /** Called before each wait, so the trace shows when and why the run paused. */
  onThrottle?: (notice: IThrottleNotice) => Promise<void>;
}

/** The HTTP response attached to a Replicate SDK `ApiError`, if any. */
function errorResponse(error: unknown): Response | undefined {
  if (typeof error !== "object" || error === null || !("response" in error))
    return undefined;
  return error.response instanceof Response ? error.response : undefined;
}

/**
 * How long to wait before retrying a throttled request, or `undefined` if the error
 * is not a 429. Uses a `Retry-After` header first, then the `~Ns` reset hint in the
 * body (quoted in the SDK's error message), then exponential backoff.
 */
export function throttleDelayMs(
  error: unknown,
  attempt: number,
): number | undefined {
  if (errorResponse(error)?.status !== 429) return undefined;
  const header = errorResponse(error)?.headers.get("Retry-After");
  const headerSeconds = header ? Number(header) : Number.NaN;
  const hint = /resets in ~(\d+(?:\.\d+)?)s/.exec(
    error instanceof Error ? error.message : "",
  )?.[1];
  const seconds =
    Number.isFinite(headerSeconds) && headerSeconds >= 0
      ? headerSeconds
      : Number(hint ?? Number.NaN);
  const wait = Number.isFinite(seconds)
    ? seconds * 1000
    : fallbackBaseMs * 2 ** attempt;
  return Math.min(wait, maxWaitMs);
}

/** Sleeps for `ms`, rejecting as soon as `signal` aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs a Replicate request, waiting out 429 responses and retrying. Only safe for
 * requests a 429 proves were not executed, which is every Replicate request: a
 * throttled prediction creation never creates a prediction.
 */
export async function withThrottleRetry<T>(
  request: () => Promise<T>,
  options: IThrottleOptions,
  attempt = 0,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const waitMs = throttleDelayMs(error, attempt);
    if (waitMs === undefined) throw error;
    if (attempt + 1 >= maxThrottleAttempts) {
      throw new RateLimited(
        `Replicate kept throttling ${options.operation} after ${maxThrottleAttempts} attempts. Check the account's rate limits and credit balance.`,
        { cause: error },
      );
    }
    await options.onThrottle?.({
      operation: options.operation,
      attempt: attempt + 1,
      waitMs,
    });
    try {
      await pause(waitMs, options.signal);
    } catch (reason) {
      throw new RateLimited(
        `Interrupted while waiting for Replicate's rate limit to reset.`,
        { cause: reason },
      );
    }
    return withThrottleRetry(request, options, attempt + 1);
  }
}

/**
 * Enforces a minimum gap between the starts of outgoing requests, keeping a run
 * under a known per-minute limit instead of relying on 429 recovery alone.
 */
export class RequestSpacer {
  private nextStart = 0;

  /** A gap of 0 disables spacing. */
  constructor(private readonly minIntervalMs: number) {}

  /** Resolves when the next request may start, reserving that slot. */
  async reserve(signal: AbortSignal | undefined): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const start = Math.max(now, this.nextStart);
    this.nextStart = start + this.minIntervalMs;
    if (start > now)
      await pause(start - now, signal ?? new AbortController().signal);
  }
}
