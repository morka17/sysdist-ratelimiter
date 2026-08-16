import type { RateLimitAlgorithm, AlgorithmConfig } from './algorithm.interface.js';
import type { StoreInterface } from '../../store/interface.store.js';
import type { RateLimitResult } from '../result.js';

/** Stable algorithm identifier, used by limiter.ts's ALGORITHM_REGISTRY and in logs/metrics. */
export const SLIDING_WINDOW_ALGORITHM_NAME = 'sliding-window' as const;

/**
 * Default sliding-window-log algorithm.
 *
 * This class is intentionally a thin adapter: all atomicity and the actual
 * window-trim/count/expire logic live in the store implementation (for
 * Redis, in `sliding-window.lua`, executed via a single EVALSHA round-trip).
 * Keeping this file free of backend logic is what lets `limiter.ts` swap
 * algorithms and stores independently.
 */
export class SlidingWindowAlgorithm implements RateLimitAlgorithm<AlgorithmConfig> {
  public readonly name = SLIDING_WINDOW_ALGORITHM_NAME;

  public async consume(
    store: StoreInterface,
    key: string,
    config: AlgorithmConfig,
  ): Promise<RateLimitResult> {
    validateConfig(config);
    return store.increment(key, config.duration, config.points, config);
  }
}

/**
 * Fails fast on obviously invalid config rather than letting a malformed
 * request silently reach the store. Deeper validation (types, ranges) is
 * the responsibility of `config/schema.ts` at registration time; this is
 * a cheap defensive check for programmatic (non-middleware) callers who
 * construct a RateLimiter directly.
 */
function validateConfig(config: AlgorithmConfig): void {
  if (config.points <= 0) {
    throw new RangeError(`AlgorithmConfig.points must be > 0, received ${config.points}`);
  }
  if (config.duration <= 0) {
    throw new RangeError(`AlgorithmConfig.duration must be > 0, received ${config.duration}`);
  }
  if (!config.keyPrefix) {
    throw new RangeError('AlgorithmConfig.keyPrefix must be a non-empty string');
  }
}