import type { RateLimitAlgorithm, AlgorithmConfig } from './algorithms/algorithm.interface.js';
import { SlidingWindowAlgorithm, SLIDING_WINDOW_ALGORITHM_NAME } from './algorithms/sliding_window.js';
import { TokenBucketAlgorithm, TOKEN_BUCKET_ALGORITHM_NAME, type TokenBucketConfig } from './algorithms/token_bucket.js';
import type { StoreInterface } from '../store/interface.store.js';
import { buildRateLimitResult, type RateLimitResult } from './result.js';
import type { ResolvedRateLimiterConfig } from '../config/schema.js';
import { type Logger, createDefaultLogger } from '../telemetry/logger.js';
import { type MetricsRecorder, createNoopMetricsRecorder } from '../telemetry/metrics.js';
import { RateLimiterUnavailableError } from '../errors/rate-limit-exceeded.error.js';

/**
 * Maps `config.algorithm` to an algorithm factory. Adding a new algorithm
 * means: implement `RateLimitAlgorithm`, register it here, and (if it needs
 * atomicity beyond a plain increment) give the store implementations a way
 * to detect and dispatch to it — see `store/interface.store.ts`'s
 * `algorithmConfig` param and `token-bucket.ts`'s `isTokenBucketConfig`.
 *
 * Values are constructed lazily (factories, not instances) so unused
 * algorithms never pay instantiation cost, and so each `RateLimiter`
 * instance gets its own algorithm object rather than sharing mutable state
 * across instances (the algorithm classes are currently stateless, but this
 * keeps the registry safe if that ever changes).
 */
const ALGORITHM_REGISTRY: Record<string, () => RateLimitAlgorithm<AlgorithmConfig>> = {
  [SLIDING_WINDOW_ALGORITHM_NAME]: () => new SlidingWindowAlgorithm(),
  [TOKEN_BUCKET_ALGORITHM_NAME]: () => new TokenBucketAlgorithm(),
};

export interface RateLimiterDeps {
  logger?: Logger;
  metrics?: MetricsRecorder;
}

/**
 * Central orchestrator. Given a resolved config and a store, exposes a
 * single `checkLimit(key)` method used by every middleware adapter
 * (`middleware/express.ts`, `middleware/fastify.ts`) and any direct
 * programmatic caller. Keeps framework code framework-only: nothing here
 * knows about Express, Fastify, or HTTP at all.
 */
export class RateLimiter {
  private readonly config: ResolvedRateLimiterConfig;
  private readonly store: StoreInterface;
  private readonly algorithm: RateLimitAlgorithm<AlgorithmConfig>;
  private readonly logger: Logger;
  private readonly metrics: MetricsRecorder;

  constructor(config: ResolvedRateLimiterConfig, store: StoreInterface, deps: RateLimiterDeps = {}) {
    const algorithmFactory = ALGORITHM_REGISTRY[config.algorithm];
    if (!algorithmFactory) {
      throw new RangeError(
        `Unknown algorithm "${config.algorithm}". Registered algorithms: ${Object.keys(ALGORITHM_REGISTRY).join(', ')}`,
      );
    }

    this.config = config;
    this.store = store;
    this.algorithm = algorithmFactory();
    this.logger = deps.logger ?? createDefaultLogger();
    this.metrics = deps.metrics ?? createNoopMetricsRecorder();
  }

  /**
   * Evaluates and records one request for `key`, returning the resulting
   * decision. Never rejects for an expected "over limit" outcome — that's
   * represented by `result.allowed === false`. Only rejects when the store
   * is unreachable AND `config.failMode === 'closed'`; when
   * `failMode === 'open'` (the default), a store failure is logged, a
   * fallback metric is recorded, and a synthetic "allowed" result is
   * returned instead of rejecting, so an outage in Redis doesn't take down
   * the protected service.
   */
  public async checkLimit(key: string): Promise<RateLimitResult> {
    const startedAt = performance.now();
    const algorithmConfig = this.buildAlgorithmConfig();

    try {
      const result = await this.algorithm.consume(this.store, key, algorithmConfig);
      this.metrics.recordLatency(performance.now() - startedAt);
      this.metrics.recordDecision(result.allowed);
      return result;
    } catch (error) {
      this.metrics.recordRedisError();

      if (this.config.failMode === 'closed') {
        this.logger.error(
          { key, algorithm: this.config.algorithm, error: serializeError(error) },
          'Rate limiter store unavailable; failMode=closed, rejecting request',
        );
        throw new RateLimiterUnavailableError('Rate limiter backing store is unavailable', error);
      }

      this.logger.warn(
        { key, algorithm: this.config.algorithm, error: serializeError(error) },
        'Rate limiter store unavailable; failMode=open, allowing request through',
      );
      this.metrics.recordFallback();
      this.metrics.recordDecision(true);

      return this.buildFallbackAllowedResult(algorithmConfig);
    }
  }

  /** Clears all rate-limit state for `key`. Delegates directly to the store. */
  public async reset(key: string): Promise<void> {
    await this.store.reset(key);
  }

  /** Tears down the underlying store connection. Safe to call multiple times. */
  public async close(): Promise<void> {
    await this.store.close();
  }

  /**
   * Translates the resolved config into the algorithm-specific config
   * shape. Token-bucket requires `refillRate`/`bucketSize`, validated here
   * (rather than only in `config/schema.ts`) so a `RateLimiter`
   * constructed programmatically (bypassing `resolveConfig`) still fails
   * fast instead of producing a confusing downstream error.
   */
  private buildAlgorithmConfig(): AlgorithmConfig {
    const base: AlgorithmConfig = {
      points: this.config.points,
      duration: this.config.duration,
      keyPrefix: this.config.store.keyPrefix,
    };

    if (this.config.algorithm === TOKEN_BUCKET_ALGORITHM_NAME) {
      if (this.config.refillRate === undefined || this.config.bucketSize === undefined) {
        throw new RangeError(
          "config.refillRate and config.bucketSize are required when algorithm is 'token-bucket'",
        );
      }
      const tokenBucketConfig: TokenBucketConfig = {
        ...base,
        refillRate: this.config.refillRate,
        bucketSize: this.config.bucketSize,
      };
      return tokenBucketConfig;
    }

    return base;
  }

  /**
   * Synthetic "allowed" result used only on the failMode=open fallback
   * path. `totalHits`/`remaining` are reported optimistically (0 hits,
   * full limit remaining) since the store couldn't tell us the real count —
   * callers should treat this result's `totalHits`/`remaining` as
   * informational only in this specific failure scenario, not as ground
   * truth about the caller's actual usage.
   */
  private buildFallbackAllowedResult(algorithmConfig: AlgorithmConfig): RateLimitResult {
    const limit = isTokenBucketAlgorithmConfig(algorithmConfig) ? algorithmConfig.bucketSize : algorithmConfig.points;
    return buildRateLimitResult({
      limit,
      totalHits: 0,
      resetMs: algorithmConfig.duration * 1000,
    });
  }
}

function isTokenBucketAlgorithmConfig(config: AlgorithmConfig): config is TokenBucketConfig {
  return (
    typeof (config as Partial<TokenBucketConfig>).refillRate === 'number' &&
    typeof (config as Partial<TokenBucketConfig>).bucketSize === 'number'
  );
}

/** Normalizes a caught `unknown` into a loggable shape without losing the stack trace. */
function serializeError(error: unknown): { message: string; stack?: string } | unknown {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return error;
}