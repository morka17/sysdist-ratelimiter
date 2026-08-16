import { rateLimiterOptionsSchema, type RateLimiterOptions, type ResolvedRateLimiterConfig } from './schema.js';
import { DEFAULT_KEY_GENERATOR } from '../middleware/shared/key-generator.js';

/**
 * Hardcoded defaults applied when a field is not supplied by the caller.
 * This is the ONLY place default values for `RateLimiterOptions` should
 * live — no other file should inline a fallback for one of these fields.
 */
export const DEFAULT_OPTIONS = {
  algorithm: 'sliding-window' as const,
  points: 100,
  duration: 60,
  keyPrefix: 'rl',
  failMode: 'open' as const,
  headers: true,
  keyGenerator: DEFAULT_KEY_GENERATOR,
  metrics: { enabled: false },
};

/**
 * Merges user-supplied options with `DEFAULT_OPTIONS`, validates the merged
 * result via `rateLimiterOptionsSchema`, and returns a fully populated
 * `ResolvedRateLimiterConfig`. Throws synchronously (fail fast, at
 * middleware-registration time, not at request time) if the merged config
 * is invalid.
 */
export function resolveConfig(options: RateLimiterOptions): ResolvedRateLimiterConfig {
  const merged: RateLimiterOptions = {
    ...options,
    store: {
      ...options.store,
      keyPrefix: options.store?.keyPrefix ?? DEFAULT_OPTIONS.keyPrefix,
    },
    algorithm: options.algorithm ?? DEFAULT_OPTIONS.algorithm,
    points: options.points ?? DEFAULT_OPTIONS.points,
    duration: options.duration ?? DEFAULT_OPTIONS.duration,
    failMode: options.failMode ?? DEFAULT_OPTIONS.failMode,
    headers: options.headers ?? DEFAULT_OPTIONS.headers,
    keyGenerator: options.keyGenerator ?? DEFAULT_OPTIONS.keyGenerator,
    metrics: {
      enabled: options.metrics?.enabled ?? DEFAULT_OPTIONS.metrics.enabled,
      registry: options.metrics?.registry,
    },
  };

  const parsed = rateLimiterOptionsSchema.parse(merged);

  // Fields guaranteed present after the merge above but typed optional on
  // RateLimiterOptions; asserted here once, at the single boundary where
  // "raw options" become "resolved config" for the rest of the codebase.
  const resolved: ResolvedRateLimiterConfig = {
    store: {
      client: parsed.store.client,
      type: parsed.store.type ?? 'redis',
      keyPrefix: parsed.store.keyPrefix ?? DEFAULT_OPTIONS.keyPrefix,
    },
    algorithm: parsed.algorithm ?? DEFAULT_OPTIONS.algorithm,
    points: parsed.points ?? DEFAULT_OPTIONS.points,
    duration: parsed.duration ?? DEFAULT_OPTIONS.duration,
    refillRate: parsed.refillRate,
    bucketSize: parsed.bucketSize,
    keyGenerator: (parsed.keyGenerator ?? DEFAULT_OPTIONS.keyGenerator) as ResolvedRateLimiterConfig['keyGenerator'],
    failMode: parsed.failMode ?? DEFAULT_OPTIONS.failMode,
    skip: parsed.skip,
    headers: parsed.headers ?? DEFAULT_OPTIONS.headers,
    onLimitExceeded: parsed.onLimitExceeded,
    metrics: {
      enabled: parsed.metrics?.enabled ?? DEFAULT_OPTIONS.metrics.enabled,
      registry: parsed.metrics?.registry,
    },
    logger: parsed.logger,
  };

  return resolved;
}