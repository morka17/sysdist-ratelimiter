import type { RateLimitResult } from '../result.js';
import type { StoreInterface } from '../../store/interface.store';

/**
 * Base configuration shared by every rate-limiting algorithm.
 * Algorithm-specific configs (e.g. TokenBucketConfig) extend this.
 */
export interface AlgorithmConfig {
  /** Max requests/points allowed per window. */
  readonly points: number;
  /** Window length in seconds. */
  readonly duration: number;
  /** Redis/store key namespace, e.g. "rl". */
  readonly keyPrefix: string;
}

/**
 * Contract every rate-limiting algorithm must implement. Decouples
 * `core/limiter.ts` from any specific algorithm implementation, and
 * decouples algorithms from any specific store implementation (they
 * depend on `StoreInterface`, never on `RedisStore`/`MemoryStore` directly).
 */
export interface RateLimitAlgorithm<TConfig extends AlgorithmConfig = AlgorithmConfig> {
  /** Stable identifier used by `limiter.ts`'s ALGORITHM_REGISTRY and in logs/metrics. */
  readonly name: string;

  /**
   * Consumes one unit of the limit for `key` and returns the resulting
   * decision. Implementations MUST delegate the atomic increment/check
   * to `store.increment()` — algorithms must never talk to a backend
   * (e.g. Redis) directly.
   */
  consume(store: StoreInterface, key: string, config: TConfig): Promise<RateLimitResult>;
}