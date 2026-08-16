import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import type { AlgorithmConfig } from '../../core/algorithms/algorithm.interface.js';
import { isTokenBucketConfig } from '../../core/algorithms/token_bucket.js';
import { buildRateLimitResult, type RateLimitResult } from '../../core/result.js';
import type { StoreInterface } from '../interface.store.js';
import type { RedisScriptClient } from './cluster-client.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

const SLIDING_WINDOW_SCRIPT = readFileSync(join(moduleDir, 'scripts', 'sliding-window.lua'), 'utf8');
const TOKEN_BUCKET_SCRIPT = readFileSync(join(moduleDir, 'scripts', 'token-bucket.lua'), 'utf8');

export interface RedisStoreOptions {
  readonly client: RedisScriptClient;
  /** When true, `close()` calls `quit()` on the injected client. */
  readonly ownsClient?: boolean;
  /** Applied on `reset()` and as a fallback when `algorithmConfig.keyPrefix` is absent. */
  readonly keyPrefix?: string;
}

/**
 * Redis-backed store executing one atomic Lua script per `increment()` call.
 * Keys are hash-tagged (`{...}`) so cluster deployments keep each script's
 * keys on a single shard.
 */
export class RedisStore implements StoreInterface {
  private readonly client: RedisScriptClient;
  private readonly ownsClient: boolean;
  private readonly keyPrefix?: string;
  private readonly slidingWindowSha: Promise<string>;
  private readonly tokenBucketSha: Promise<string>;
  private closed = false;

  constructor(options: RedisStoreOptions) {
    this.client = options.client;
    this.ownsClient = options.ownsClient ?? false;
    this.keyPrefix = options.keyPrefix;
    this.slidingWindowSha = this.loadScript(SLIDING_WINDOW_SCRIPT);
    this.tokenBucketSha = this.loadScript(TOKEN_BUCKET_SCRIPT);
  }

  public async increment(
    key: string,
    windowSeconds: number,
    limit: number,
    algorithmConfig?: AlgorithmConfig,
  ): Promise<RateLimitResult> {
    const redisKey = toHashTaggedKey(key, algorithmConfig?.keyPrefix);
    const now = Date.now();

    if (algorithmConfig !== undefined && isTokenBucketConfig(algorithmConfig)) {
      const sha = await this.tokenBucketSha;
      const raw = await this.client.evalsha(
        sha,
        1,
        redisKey,
        algorithmConfig.bucketSize,
        algorithmConfig.refillRate,
        now,
        windowSeconds,
      );

      return parseScriptResult(raw, algorithmConfig.bucketSize);
    }

    const sha = await this.slidingWindowSha;
    const raw = await this.client.evalsha(
      sha,
      1,
      redisKey,
      windowSeconds,
      limit,
      now,
      randomUUID(),
    );

    return parseScriptResult(raw, limit);
  }

  public async reset(key: string): Promise<void> {
    const redisKey = toHashTaggedKey(key, this.keyPrefix);
    await this.client.del(redisKey);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.ownsClient) {
      await this.client.quit();
    }
  }

  private loadScript(source: string): Promise<string> {
    return this.client.script('LOAD', source);
  }
}

function toHashTaggedKey(key: string, keyPrefix?: string): string {
  const namespacedKey = keyPrefix !== undefined && keyPrefix.length > 0 ? `${keyPrefix}:${key}` : key;
  return `{${namespacedKey}}`;
}

function parseScriptResult(raw: unknown, limit: number): RateLimitResult {
  if (!Array.isArray(raw) || raw.length < 5) {
    throw new Error('Unexpected Redis script response');
  }

  const scriptLimit = Number(raw[2]);
  const resetMs = Number(raw[3]);
  const totalHits = Number(raw[4]);

  return buildRateLimitResult({
    limit: Number.isFinite(scriptLimit) ? scriptLimit : limit,
    totalHits,
    resetMs,
  });
}
