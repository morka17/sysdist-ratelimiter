import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Cluster } from 'ioredis';
import type { Logger } from '../../telemetry/logger.js';
import { createDefaultLogger } from '../../telemetry/logger.js';
import { loadLuaScript } from './scripts/loader.js';

const RELEASE_LOCK_COMMAND_NAME = 'rlReleaseLock';
const DEFAULT_TTL_MS = 5000;

type RedisLikeClient = Redis | Cluster;
type ClientWithReleaseCommand = RedisLikeClient & {
  rlReleaseLock(key: string, token: string): Promise<number>;
};

export interface LockHandle {
  readonly key: string;
  readonly token: string;
  release(): Promise<void>;
}

export interface DistributedLockOptions {
  client: RedisLikeClient;
  /** Lock lifetime in milliseconds. Default 5000. Should comfortably exceed the coordination work it guards. */
  ttlMs?: number;
  logger?: Logger;
}

/**
 * Redlock-style single-instance distributed lock, intended ONLY for rare,
 * non-hot-path coordination (e.g. a future config-sync feature, cache
 * warmup). This is never used by `RateLimiter.checkLimit()` — the
 * per-request path stays lock-free via the sliding-window Lua script (see
 * `redis-store.ts`). Taking a lock on every request is exactly the
 * throughput-killing pattern this library's architecture avoids.
 *
 * "Redlock-style" here means: SET NX PX with a random token, and release
 * via a compare-then-delete Lua script so an instance can never release a
 * lock it doesn't currently hold (e.g. one that expired and was
 * re-acquired by another instance in the meantime).
 */
export class DistributedLock {
  private readonly client: RedisLikeClient;
  private readonly ttlMs: number;
  private readonly logger: Logger;
  private releaseCommandDefined = false;

  constructor(options: DistributedLockOptions) {
    this.client = options.client;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.logger = options.logger ?? createDefaultLogger();
  }

  /**
   * Attempts to acquire the lock for `key`. Returns `null` immediately if
   * already held by someone else — callers should treat that as "someone
   * else is doing this coordination work right now," not as an error.
   */
  public async acquire(key: string): Promise<LockHandle | null> {
    const token = this.generateToken();
    const result = await this.client.set(key, token, 'PX', this.ttlMs, 'NX');

    if (result !== 'OK') {
      return null;
    }

    return {
      key,
      token,
      release: () => this.release(key, token),
    };
  }

  private async release(key: string, token: string): Promise<void> {
    this.ensureReleaseCommandDefined();
    const client = this.client as unknown as ClientWithReleaseCommand;

    const released = await client.rlReleaseLock(key, token);
    if (released === 0) {
      this.logger.warn(
        { key },
        'DistributedLock.release: token mismatch or lock already expired — nothing released',
      );
    }
  }

  private ensureReleaseCommandDefined(): void {
    if (this.releaseCommandDefined) {
      return;
    }
    const lua = loadLuaScript('release-lock.lua');
    this.client.defineCommand(RELEASE_LOCK_COMMAND_NAME, { numberOfKeys: 1, lua });
    this.releaseCommandDefined = true;
  }

  private generateToken(): string {
    return randomUUID();
  }
}