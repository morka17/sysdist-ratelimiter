import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/store/memory-store.js';
import type { AlgorithmConfig } from '../src/core/algorithms/algorithm.interface.js';
import type { TokenBucketConfig } from '../src/core/algorithms/token_bucket.js';

const slidingConfig: AlgorithmConfig = { points: 2, duration: 60, keyPrefix: 'rl' };
const tokenConfig: TokenBucketConfig = {
  points: 50,
  duration: 60,
  keyPrefix: 'rl',
  refillRate: 10,
  bucketSize: 2,
};

describe('MemoryStore — sliding window', () => {
  it('allows requests up to the limit then denies', async () => {
    const store = new MemoryStore('rl');

    const first = await store.increment('user:1', 60, 2, slidingConfig);
    const second = await store.increment('user:1', 60, 2, slidingConfig);
    const third = await store.increment('user:1', 60, 2, slidingConfig);

    expect(first.allowed).toBe(true);
    expect(first.totalHits).toBe(1);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.totalHits).toBe(3);
  });

  it('reset() clears state for a key', async () => {
    const store = new MemoryStore('rl');

    await store.increment('user:1', 60, 1, slidingConfig);
    const denied = await store.increment('user:1', 60, 1, slidingConfig);
    expect(denied.allowed).toBe(false);

    await store.reset('user:1');

    const afterReset = await store.increment('user:1', 60, 1, slidingConfig);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.totalHits).toBe(1);
  });
});

describe('MemoryStore — token bucket', () => {
  it('consumes burst capacity then denies until refill', async () => {
    const store = new MemoryStore('rl');

    const first = await store.increment('user:2', 1, 2, tokenConfig);
    const second = await store.increment('user:2', 1, 2, tokenConfig);
    const third = await store.increment('user:2', 1, 2, tokenConfig);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
  });
});
