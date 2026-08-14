/**
 * Canonical result shape returned by every algorithm/store operation.
 *
 * Consumed by:
 *  - middleware/shared/response-headers.ts (sets RateLimit-* / Retry-After headers)
 *  - errors/rate-limit-exceeded.error.ts (carries this as `.info`)
 *
 * Invariant: `totalHits` reflects the count AFTER the current request has been
 * recorded, so `remaining` is always `Math.max(0, limit - totalHits)`.
 */
export interface RateLimitResult {
    /** Whether this request is allowed to proceed. */
    readonly allowed: boolean;
    /** Requests remaining in the current window/bucket after this request. */
    readonly remaining: number;
    /** The configured limit (`points` / `bucketSize`), echoed for convenience. */
    readonly limit: number;
    /** Milliseconds until the window resets or the bucket next refills. */
    readonly resetMs: number;
    /** Total requests counted in the current window (post-increment). */
    readonly totalHits: number;
  }
  
  /**
   * Builds a RateLimitResult, centralizing the `remaining` derivation so
   * callers never compute it ad hoc and risk negative values.
   */
  export function buildRateLimitResult(params: {
    limit: number;
    totalHits: number;
    resetMs: number;
  }): RateLimitResult {
    const { limit, totalHits, resetMs } = params;
    const remaining = Math.max(0, limit - totalHits);
    return {
      allowed: totalHits <= limit,
      remaining,
      limit,
      resetMs,
      totalHits,
    };
  }