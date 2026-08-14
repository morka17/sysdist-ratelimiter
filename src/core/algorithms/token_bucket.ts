import type { RateLimitAlgorithm, AlgorithmConfig } from './algorithm.interface.js';
import type { StoreInterface } from '../../store/interface.store';
import type { RateLimitResult } from '../result.js';

/** Stable algorithm identifier, used by limiter.ts's ALGORITHM_REGISTRY and in logs/metrics. */
export const TOKEN_BUCKET_ALGORITHM_NAME = 'token-bucket' as const;

/**
 * Config for burst-tolerant, steady-refill-rate limiting.
 *
 * `points`/`duration` (inherited from AlgorithmConfig) are not used to
 * derive the decision directly for this algorithm — `bucketSize` and
 * `refillRate` are authoritative. They are kept on the interface so a
 * config object can be validated/typed uniformly across algorithms and
 * so callers migrating from sliding-window to token-bucket don't need to
 * strip fields.
 */
export interface TokenBucketConfig extends AlgorithmConfig {
  /** Tokens added back to the bucket per second. Must be > 0. */
  readonly refillRate: number;
  /** Maximum token capacity ("burst" ceiling). Must be > 0. */
  readonly bucketSize: number;
}

/**
 * Token-bucket algorithm: like sliding-window, this is a thin adapter.
 * The store implementation is responsible for detecting the presence of
 * `refillRate`/`bucketSize` on the passed config (see
 * `store/interface.store.ts`'s `algorithmConfig` param) and dispatching
 * to the appropriate atomic script (e.g. `token-bucket.lua` on Redis)
 * rather than the sliding-window script.
 */
export class TokenBucketAlgorithm implements RateLimitAlgorithm<TokenBucketConfig> {
  public readonly name = TOKEN_BUCKET_ALGORITHM_NAME;

  public async consume(
    store: StoreInterface,
    key: string,
    config: TokenBucketConfig,
  ): Promise<RateLimitResult> {
    validateConfig(config);
    // windowSeconds has no direct meaning for token-bucket; pass a
    // derived value (time to fully refill from empty) so stores that
    // don't special-case token-bucket still get a sane TTL to key off.
    const windowSeconds = config.bucketSize / config.refillRate;
    return store.increment(key, windowSeconds, config.bucketSize, config);
  }
}

function validateConfig(config: TokenBucketConfig): void {
  if (config.bucketSize <= 0) {
    throw new RangeError(`TokenBucketConfig.bucketSize must be > 0, received ${config.bucketSize}`);
  }
  if (config.refillRate <= 0) {
    throw new RangeError(`TokenBucketConfig.refillRate must be > 0, received ${config.refillRate}`);
  }
  if (!config.keyPrefix) {
    throw new RangeError('TokenBucketConfig.keyPrefix must be a non-empty string');
  }
}

/** Type guard used by stores/callers that receive a plain AlgorithmConfig and need to know if it's a token-bucket config. */
export function isTokenBucketConfig(config: AlgorithmConfig): config is TokenBucketConfig {
  return (
    typeof (config as Partial<TokenBucketConfig>).refillRate === 'number' &&
    typeof (config as Partial<TokenBucketConfig>).bucketSize === 'number'
  );
}