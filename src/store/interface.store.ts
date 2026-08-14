import type { RateLimitResult } from '../core/result';
import type { AlgorithmConfig } from '../core/algorithms/algorithm.interface';

/**
 * Backend-agnostic contract for any rate-limit data store (Redis, memory,
 * or a future custom backend). Algorithms depend on this interface only —
 * never on a concrete store implementation — so `core/` stays decoupled
 * from `store/`.
 *
 * NOTE: This is a type-only dependency edge with algorithm.interface.ts
 * (mutual `import type`), which TypeScript resolves at compile time with
 * no runtime circularity, since interfaces are erased.
 */
export interface StoreInterface {
  /**
   * Atomically records one "hit" for `key` and returns the resulting
   * rate-limit decision. Implementations MUST perform this as a single
   * atomic operation (e.g. a Lua script on Redis) to remain correct under
   * concurrent access from multiple instances.
   *
   * @param key            Fully-qualified rate-limit key (already prefixed).
   * @param windowSeconds  Window length in seconds (sliding-window) or the
   *                        bucket's refill interval basis (token-bucket).
   * @param limit           Max points/tokens allowed (`points` / `bucketSize`).
   * @param algorithmConfig Full algorithm config, allowing the store to branch
   *                        on shape (e.g. detect `refillRate`/`bucketSize` for
   *                        token-bucket vs plain sliding-window).
   */
  increment(
    key: string,
    windowSeconds: number,
    limit: number,
    algorithmConfig?: AlgorithmConfig,
  ): Promise<RateLimitResult>;

  /** Clears all rate-limit state for `key`. */
  reset(key: string): Promise<void>;

  /** Tears down underlying connections. Safe to call multiple times. */
  close(): Promise<void>;
}