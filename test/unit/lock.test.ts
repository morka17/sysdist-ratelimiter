import { describe, it, expect, afterAll } from 'vitest';
import Redis from 'ioredis';
import { DistributedLock } from '../../src/store/redis/lock.js';
import { resolveTestRedisUrl } from '../helpers/env.js';

const redisUrl = resolveTestRedisUrl();

let redisAvailable = false;
try {
  const probe = new Redis(redisUrl ?? 'redis://127.0.0.1:6379', {
    lazyConnect: true,
    connectTimeout: 500,
  });
  await probe.connect();
  await probe.ping();
  await probe.quit();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}

const suite = redisAvailable ? describe : describe.skip;
const clients: Redis[] = [];

function makeClient(): Redis {
  const client = new Redis(redisUrl ?? 'redis://127.0.0.1:6379');
  clients.push(client);
  return client;
}

suite('DistributedLock', () => {
  it('acquires a free lock and returns a handle with a random token', async () => {
    const lock = new DistributedLock({ client: makeClient() });
    const key = `lock:test:${Date.now()}:a`;

    const handle = await lock.acquire(key);

    expect(handle).not.toBeNull();
    expect(handle?.key).toBe(key);
    expect(handle?.token).toMatch(/^[0-9a-f-]{36}$/i);

    await handle?.release();
  });

  it('returns null when the lock is already held by someone else', async () => {
    const clientA = makeClient();
    const clientB = makeClient();
    const lockA = new DistributedLock({ client: clientA });
    const lockB = new DistributedLock({ client: clientB });
    const key = `lock:test:${Date.now()}:b`;

    const handleA = await lockA.acquire(key);
    expect(handleA).not.toBeNull();

    const handleB = await lockB.acquire(key);
    expect(handleB).toBeNull();

    await handleA?.release();
  });

  it('allows re-acquisition after the lock holder releases it', async () => {
    const client = makeClient();
    const lock = new DistributedLock({ client });
    const key = `lock:test:${Date.now()}:c`;

    const first = await lock.acquire(key);
    expect(first).not.toBeNull();
    await first?.release();

    const second = await lock.acquire(key);
    expect(second).not.toBeNull();

    await second?.release();
  });

  it('does not release a lock re-acquired by someone else after the original TTL expired', async () => {
    const clientA = makeClient();
    const clientB = makeClient();
    const key = `lock:test:${Date.now()}:d`;

    const lockA = new DistributedLock({ client: clientA, ttlMs: 100 });
    const handleA = await lockA.acquire(key);
    expect(handleA).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 200));

    const lockB = new DistributedLock({ client: clientB, ttlMs: 60_000 });
    const handleB = await lockB.acquire(key);
    expect(handleB).not.toBeNull();

    await handleA?.release();

    const stillHeldValue = await clientB.get(key);
    expect(stillHeldValue).toBe(handleB?.token);

    await handleB?.release();
  });

  it('respects the configured TTL — lock expires on its own if never released', async () => {
    const client = makeClient();
    const lock = new DistributedLock({ client, ttlMs: 100 });
    const key = `lock:test:${Date.now()}:e`;

    const handle = await lock.acquire(key);
    expect(handle).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 200));

    const value = await client.get(key);
    expect(value).toBeNull();
  });
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
});
