import { resolveConfig } from '../../config/default.js';
import type { RateLimiterOptions, ResolvedRateLimiterConfig } from '../../config/schema.js';
import { RateLimiter } from '../../core/limiter.js';
import type { StoreInterface } from '../../store/interface.store.js';
import { MemoryStore } from '../../store/memory-store.js';
import type { RedisScriptClient } from '../../store/redis/cluster-client.js';
import { RedisStore } from '../../store/redis/redis-store.js';
import { type Logger, createDefaultLogger } from '../../telemetry/logger.js';
import { createMetricsRecorder } from '../../telemetry/metrics.js';

export interface LimiterBundle {
  readonly config: ResolvedRateLimiterConfig;
  readonly limiter: RateLimiter;
}

export function createLimiterBundle(options: RateLimiterOptions): LimiterBundle {
  const config = resolveConfig(options);
  const store = createStore(config);
  const logger = resolveLogger(config.logger);
  const metrics = createMetricsRecorder(config.metrics);

  return {
    config,
    limiter: new RateLimiter(config, store, { logger, metrics }),
  };
}

function createStore(config: ResolvedRateLimiterConfig): StoreInterface {
  if (config.store.type === 'memory') {
    return new MemoryStore(config.store.keyPrefix);
  }

  if (config.store.client === undefined) {
    throw new Error("store.client is required when store.type is 'redis'");
  }

  return new RedisStore({
    client: config.store.client as RedisScriptClient,
    keyPrefix: config.store.keyPrefix,
  });
}

function resolveLogger(logger: unknown): Logger {
  if (
    typeof logger === 'object' &&
    logger !== null &&
    typeof (logger as Logger).debug === 'function' &&
    typeof (logger as Logger).info === 'function' &&
    typeof (logger as Logger).warn === 'function' &&
    typeof (logger as Logger).error === 'function'
  ) {
    return logger as Logger;
  }

  return createDefaultLogger();
}
