import type { RateLimitResult } from '../core/result.js';

/**
 * Thrown (or passed to `next()`/an error handler) when a request was
 * correctly evaluated and denied because the caller exceeded their limit.
 * This is an expected, well-formed outcome — not an infrastructure failure —
 * so middleware adapters typically catch this specifically to produce a
 * 429 response, distinct from `RateLimiterUnavailableError`.
 */
export class RateLimitExceededError extends Error {
  public readonly info: RateLimitResult;

  constructor(info: RateLimitResult) {
    super(
      `Rate limit exceeded: ${info.totalHits}/${info.limit} requests in the current window ` +
        `(resets in ${Math.ceil(info.resetMs / 1000)}s)`,
    );
    this.name = 'RateLimitExceededError';
    this.info = info;
    Object.setPrototypeOf(this, RateLimitExceededError.prototype);
  }
}

/**
 * Thrown when the rate limiter's backing store could not be reached and
 * `failMode: 'closed'` is configured, so the request cannot be safely
 * evaluated. Middleware adapters typically map this to a 503 response.
 * Never thrown when `failMode: 'open'` — in that mode the limiter instead
 * logs the error, records a fallback metric, and allows the request.
 */
export class RateLimiterUnavailableError extends Error {
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RateLimiterUnavailableError';
    this.cause = cause;
    Object.setPrototypeOf(this, RateLimiterUnavailableError.prototype);
  }
}