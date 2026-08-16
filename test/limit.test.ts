import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StoreInterface } from '../../src/store/store.interface.js';
import { RateLimiter } from '../src/core/limiter.js';
import { resolveConfig } from '../src/config/defaults.js';
import { RateLimiterUnavailableError } from '../src/errors/rate-limit-exceeded.error.js';
import { InMemoryMetricsRecorder } from '../src/telemetry/metrics.js';
import type { Logger } from '../src/telemetry/logger.js';
import { buildRateLimitResult } from '../src/core/result.js';

function makeSilentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeMockStore(): StoreInterface & {
  increment: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    increment: vi.fn(),
    reset: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('RateLimiter — sliding-window happy path', () => {
  it('delegates to the store with the resolved algorithm config and returns its result', async () => {
    const store = makeMockStore();
    const expected = buildRateLimitResult({ limit: 100, totalHits: 5, resetMs: 60_000 });
    store.increment.mockResolvedValue(expected);

    const config = resolveConfig({ store: {}, points: 100, duration: 60 });
    const limiter = new RateLimiter(config, store, { logger: makeSilentLogger() });

    const result = await limiter.checkLimit('user:1');

    expect(store.increment).toHaveBeenCalledWith(
      'user:1',
      60,
      100,
      { points: 100, duration: 60, keyPrefix: 'rl' },
    );
    expect(result).toEqual(expected);
  });

  it('records decision and latency metrics on success', async () => {
    const store = makeMockStore();
    store.increment.mockResolvedValue(buildRateLimitResult({ limit: 10, totalHits: 1, resetMs: 1000 }));
    const metrics = new InMemoryMetricsRecorder();

    const config = resolveConfig({ store: {}, points: 10, duration: 1 });
    const limiter = new RateLimiter(config, store, { logger: makeSilentLogger(), metrics });

    await limiter.checkLimit('k');

    const snapshot = metrics.snapshot();
    expect(snapshot.allowedTotal).toBe(1);
    expect(snapshot.deniedTotal).toBe(0);
    expect(snapshot.latencySamplesMs).toHaveLength(1);
  });

  it('records a denied decision when the store reports over-limit', async () => {
    const store = makeMockStore();
    store.increment.mockResolvedValue(buildRateLimitResult({ limit: 10, totalHits: 11, resetMs: 1000 }));
    const metrics = new InMemoryMetricsRecorder();

    const config = resolveConfig({ store: {}, points: 10, duration: 1 });
    const limiter = new RateLimiter(config, store, { logger: makeSilentLogger(), metrics });

    const result = await limiter.checkLimit('k');

    expect(result.allowed).toBe(false);
    expect(metrics.snapshot().deniedTotal).toBe(1);
  });
});

describe('RateLimiter — token-bucket', () => {
  it('builds a TokenBucketConfig and passes bucketSize/refillRate through', async () => {
    const store = makeMockStore();
    store.increment.mockResolvedValue(buildRateLimitResult({ limit: 50, totalHits: 1, resetMs: 5000 }));

    const config = resolveConfig({
      store: {},
      algorithm: 'token-bucket',
      refillRate: 10,
      bucketSize: 50,
    });
    const limiter = new RateLimiter(config, store, { logger: makeSilentLogger() });

    await limiter.checkLimit('user:1');

    expect(store.increment).toHaveBeenCalledWith(
      'user:1',
      5, // bucketSize / refillRate
      50,
      expect.objectContaining({ refillRate: 10, bucketSize: 50, keyPrefix: 'rl' }),
    );
  });

  it('throws a RangeError if constructed with algorithm=token-bucket but no refillRate/bucketSize', async () => {
    const store = makeMockStore();
    // Bypass resolveConfig's own validation to simulate a programmatic
    // caller constructing a ResolvedRateLimiterConfig by hand incorrectly.
    const badConfig = resolveConfig({ store: {}, algorithm: 'token-bucket', refillRate: 1, bucketSize: 1 });
    // @ts-expect-error intentionally corrupting the resolved config for this test
    badConfig.refillRate = undefined;

    const limiter = new RateLimiter(badConfig, store, { logger: makeSilentLogger() });

    await expect(limiter.checkLimit('k')).rejects.toThrow(/refillRate and config.bucketSize are required/);
  });
});

describe('RateLimiter — unknown algorithm', () => {
  it('throws at construction time, not at first request', () => {
    const store = makeMockStore();
    const config = resolveConfig({ store: {}, points: 1, duration: 1 });
    // @ts-expect-error intentionally invalid algorithm to exercise the guard
    config.algorithm = 'not-a-real-algorithm';

    expect(() => new RateLimiter(config, store, { logger: makeSilentLogger() })).toThrow(
      /Unknown algorithm "not-a-real-algorithm"/,
    );
  });
});

describe('RateLimiter — store failure handling', () => {
  let store: ReturnType<typeof makeMockStore>;

  beforeEach(() => {
    store = makeMockStore();
    store.increment.mockRejectedValue(new Error('ECONNREFUSED'));
  });

  it('failMode=open (default): logs a warning, records fallback metric, and returns an allowed result', async () => {
    const logger = makeSilentLogger();
    const metrics = new InMemoryMetricsRecorder();
    const config = resolveConfig({ store: {}, points: 100, duration: 60, failMode: 'open' });
    const limiter = new RateLimiter(config, store, { logger, metrics });

    const result = await limiter.checkLimit('k');

    expect(result.allowed).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    const snapshot = metrics.snapshot();
    expect(snapshot.fallbackTotal).toBe(1);
    expect(snapshot.redisErrorsTotal).toBe(1);
    expect(snapshot.allowedTotal).toBe(1);
  });

  it('failMode=closed: logs an error and throws RateLimiterUnavailableError', async () => {
    const logger = makeSilentLogger();
    const metrics = new InMemoryMetricsRecorder();
    const config = resolveConfig({ store: {}, points: 100, duration: 60, failMode: 'closed' });
    const limiter = new RateLimiter(config, store, { logger, metrics });

    await expect(limiter.checkLimit('k')).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(metrics.snapshot().redisErrorsTotal).toBe(1);
    // A rejected (closed) fallback is not a recorded "allow" decision.
    expect(metrics.snapshot().allowedTotal).toBe(0);
  });

  it('preserves the original error as `cause` on RateLimiterUnavailableError', async () => {
    const originalError = new Error('ECONNREFUSED');
    store.increment.mockRejectedValue(originalError);
    const config = resolveConfig({ store: {}, points: 1, duration: 1, failMode: 'closed' });
    const limiter = new RateLimiter(config, store, { logger: makeSilentLogger() });

    try {
      await limiter.checkLimit('k');
      expect.unreachable('expected checkLimit to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimiterUnavailableError);
      expect((err as RateLimiterUnavailableError).cause).toBe(originalError);
    }
  });
});

describe('RateLimiter — reset/close delegation', () => {
  it('reset() delegates to store.reset()', async () => {
    const store = makeMockStore();
    const config = resolveConfig({ store: {}, points: 1, duration: 1 });
    const limiter = new RateLimiter(config, store, { logger: makeSilentLogger() });

    await limiter.reset('user:1');

    expect(store.reset).toHaveBeenCalledWith('user:1');
  });

  it('close() delegates to store.close()', async () => {
    const store = makeMockStore();
    const config = resolveConfig({ store: {}, points: 1, duration: 1 });
    const limiter = new RateLimiter(config, store, { logger: makeSilentLogger() });

    await limiter.close();

    expect(store.close).toHaveBeenCalledTimes(1);
  });
});

describe('RateLimiter — default deps', () => {
  it('constructs without explicit logger/metrics and still functions', async () => {
    const store = makeMockStore();
    store.increment.mockResolvedValue(buildRateLimitResult({ limit: 1, totalHits: 1, resetMs: 0 }));
    const config = resolveConfig({ store: {}, points: 1, duration: 1 });

    const limiter = new RateLimiter(config, store);

    await expect(limiter.checkLimit('k')).resolves.toMatchObject({ allowed: true });
  });
});