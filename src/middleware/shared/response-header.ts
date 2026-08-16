import type { RateLimitResult } from '../../core/result.js';

/** Minimal header sink shared by Express and Fastify adapters. */
export interface RateLimitHeaderSink {
  setHeader(name: string, value: string | number): void;
}

/**
 * Applies IETF draft RateLimit-* headers for every evaluated request.
 * @see https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/
 */
export function applyRateLimitHeaders(sink: RateLimitHeaderSink, result: RateLimitResult): void {
  const resetSeconds = toResetSeconds(result);

  sink.setHeader('RateLimit-Limit', result.limit);
  sink.setHeader('RateLimit-Remaining', result.remaining);
  sink.setHeader('RateLimit-Reset', resetSeconds);
}

/** Sets `Retry-After` (seconds) — intended for denied (429) responses only. */
export function applyRetryAfterHeader(sink: RateLimitHeaderSink, result: RateLimitResult): void {
  sink.setHeader('Retry-After', toResetSeconds(result));
}

function toResetSeconds(result: RateLimitResult): number {
  return Math.max(1, Math.ceil(result.resetMs / 1000));
}
