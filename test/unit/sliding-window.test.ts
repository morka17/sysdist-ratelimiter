import { describe, it, expect, vi } from 'vitest';
import { SlidingWindowAlgorithm } from '../../src/core/algorithms/sliding_window.js';
import type { StoreInterface } from '../../src/store/interface.store.js';
import { buildRateLimitResult } from '../../src/core/result.js';

function makeMockStore(): StoreInterface & { increment: ReturnType<typeof vi.fn> } {
  return {
    increment: vi.fn(),
    reset: vi.fn(),
    close: vi.fn(),
  };
}

describe('SlidingWindowAlgorithm', () => {
  it('delegates to store.increment with duration, points, and config', async () => {
    const store = makeMockStore();
    const expected = buildRateLimitResult({ limit: 10, totalHits: 1, resetMs: 60_000 });
    store.increment.mockResolvedValue(expected);

    const algorithm = new SlidingWindowAlgorithm();
    const config = { points: 10, duration: 60, keyPrefix: 'rl' };

    const result = await algorithm.consume(store, 'user:1', config);

    expect(store.increment).toHaveBeenCalledWith('user:1', 60, 10, config);
    expect(result).toEqual(expected);
  });

  it('rejects non-positive points at consume time', async () => {
    const store = makeMockStore();
    const algorithm = new SlidingWindowAlgorithm();

    await expect(
      algorithm.consume(store, 'user:1', { points: 0, duration: 60, keyPrefix: 'rl' }),
    ).rejects.toThrow(/points must be > 0/);
  });

  it('rejects non-positive duration at consume time', async () => {
    const store = makeMockStore();
    const algorithm = new SlidingWindowAlgorithm();

    await expect(
      algorithm.consume(store, 'user:1', { points: 10, duration: 0, keyPrefix: 'rl' }),
    ).rejects.toThrow(/duration must be > 0/);
  });

  it('rejects an empty keyPrefix at consume time', async () => {
    const store = makeMockStore();
    const algorithm = new SlidingWindowAlgorithm();

    await expect(
      algorithm.consume(store, 'user:1', { points: 10, duration: 60, keyPrefix: '' }),
    ).rejects.toThrow(/keyPrefix must be a non-empty string/);
  });
});
