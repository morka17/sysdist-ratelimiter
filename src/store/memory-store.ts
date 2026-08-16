import type { AlgorithmConfig } from '../core/algorithms/algorithm.interface.js';
import { isTokenBucketConfig } from '../core/algorithms/token_bucket.js';
import { buildRateLimitResult, type RateLimitResult } from '../core/result.js';
import type { StoreInterface } from './interface.store.js';

interface SlidingWindowState {
  readonly kind: 'sliding-window';
  timestamps: number[];
}

interface TokenBucketState {
  readonly kind: 'token-bucket';
  tokens: number;
  lastRefillMs: number;
}

type KeyState = SlidingWindowState | TokenBucketState;

/**
 * Process-local store for development and single-instance tests.
 * Not safe across multiple processes or hosts — use `RedisStore` in production.
 */
export class MemoryStore implements StoreInterface {
  private readonly state = new Map<string, KeyState>();

  constructor(private readonly keyPrefix?: string) {}

  public async increment(
    key: string,
    windowSeconds: number,
    limit: number,
    algorithmConfig?: AlgorithmConfig,
  ): Promise<RateLimitResult> {
    const storageKey = buildStorageKey(key, algorithmConfig?.keyPrefix ?? this.keyPrefix);

    if (algorithmConfig !== undefined && isTokenBucketConfig(algorithmConfig)) {
      return this.incrementTokenBucket(
        storageKey,
        algorithmConfig.bucketSize,
        algorithmConfig.refillRate,
      );
    }

    return this.incrementSlidingWindow(storageKey, windowSeconds, limit);
  }

  public async reset(key: string): Promise<void> {
    this.state.delete(buildStorageKey(key, this.keyPrefix));
  }

  public async close(): Promise<void> {
    this.state.clear();
  }

  private incrementSlidingWindow(key: string, windowSeconds: number, limit: number): RateLimitResult {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - windowMs;

    let entry = this.state.get(key);
    if (entry === undefined || entry.kind !== 'sliding-window') {
      entry = { kind: 'sliding-window', timestamps: [] };
      this.state.set(key, entry);
    }

    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > windowStart);
    entry.timestamps.push(now);

    const totalHits = entry.timestamps.length;
    const resetMs = computeSlidingWindowResetMs(entry.timestamps, windowMs, now);

    return buildRateLimitResult({ limit, totalHits, resetMs });
  }

  private incrementTokenBucket(
    key: string,
    bucketSize: number,
    refillRate: number,
  ): RateLimitResult {
    const now = Date.now();

    let entry = this.state.get(key);
    if (entry === undefined || entry.kind !== 'token-bucket') {
      entry = { kind: 'token-bucket', tokens: bucketSize, lastRefillMs: now };
      this.state.set(key, entry);
    }

    const elapsedSeconds = Math.max(0, now - entry.lastRefillMs) / 1000;
    entry.tokens = Math.min(bucketSize, entry.tokens + elapsedSeconds * refillRate);
    entry.lastRefillMs = now;

    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      const remaining = Math.floor(entry.tokens);
      const totalHits = bucketSize - remaining;
      const resetMs = refillRate > 0 ? Math.ceil((1 / refillRate) * 1000) : 0;

      return buildRateLimitResult({ limit: bucketSize, totalHits, resetMs });
    }

    const tokensNeeded = 1 - entry.tokens;
    const resetMs = Math.ceil((tokensNeeded / refillRate) * 1000);

    return buildRateLimitResult({
      limit: bucketSize,
      totalHits: bucketSize + 1,
      resetMs,
    });
  }
}

function buildStorageKey(key: string, keyPrefix?: string): string {
  return keyPrefix !== undefined && keyPrefix.length > 0 ? `${keyPrefix}:${key}` : key;
}

function computeSlidingWindowResetMs(timestamps: readonly number[], windowMs: number, now: number): number {
  if (timestamps.length === 0) {
    return windowMs;
  }

  const oldest = timestamps[0];
  if (oldest === undefined) {
    return windowMs;
  }

  return Math.max(0, oldest + windowMs - now);
}
