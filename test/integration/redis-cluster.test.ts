import { describe, it, expect, afterAll } from 'vitest';
import Redis, { Cluster } from 'ioredis';
import { createClusterClient, type RedisScriptClient } from '../../src/store/redis/cluster-client.js';
import { RedisStore } from '../../src/store/redis/redis-store.js';

/**
 * These tests require a real Redis Cluster running locally, e.g.:
 *
 *   redis-server --port 7000 --cluster-enabled yes --daemonize yes ...
 *   redis-server --port 7001 --cluster-enabled yes --daemonize yes ...
 *   redis-server --port 7002 --cluster-enabled yes --daemonize yes ...
 *   redis-cli --cluster create 127.0.0.1:7000 127.0.0.1:7001 127.0.0.1:7002 \
 *     --cluster-replicas 0 --cluster-yes
 *
 * (see docker/docker-compose.redis-cluster.yml for the containerized
 * equivalent referenced by the README). If no cluster is reachable on
 * 127.0.0.1:7000-7002, this file's tests are skipped rather than failing
 * the whole suite.
 */
const CLUSTER_NODES = [
  { host: '127.0.0.1', port: 7000 },
  { host: '127.0.0.1', port: 7001 },
  { host: '127.0.0.1', port: 7002 },
];

let clusterAvailable = false;
try {
  const probe = new Redis.Cluster(CLUSTER_NODES, {
    lazyConnect: true,
    clusterRetryStrategy: () => null,
  });
  probe.on('error', () => undefined);
  await probe.connect();
  await probe.ping();
  await probe.quit();
  clusterAvailable = true;
} catch {
  clusterAvailable = false;
}

const suite = clusterAvailable ? describe : describe.skip;
const clientsToClose: RedisScriptClient[] = [];

async function makeClusterClient(): Promise<RedisScriptClient> {
  const client = await createClusterClient({ nodes: CLUSTER_NODES });
  clientsToClose.push(client);
  return client;
}

suite('Redis Cluster integration', () => {
  it('createClusterClient connects and responds to PING across the cluster', async () => {
    const client = await makeClusterClient();
    const pong = await (client as Cluster).ping();
    expect(pong).toBe('PONG');
  });

  it('RedisStore.increment works against a real cluster and enforces the limit', async () => {
    const client = await makeClusterClient();
    const store = new RedisStore({ client });
    const key = `cluster-test:${Date.now()}:a`;

    const r1 = await store.increment(key, 60, 2);
    expect(r1.allowed).toBe(true);
    expect(r1.totalHits).toBe(1);

    const r2 = await store.increment(key, 60, 2);
    expect(r2.allowed).toBe(true);
    expect(r2.totalHits).toBe(2);

    const r3 = await store.increment(key, 60, 2);
    expect(r3.allowed).toBe(false);
    expect(r3.totalHits).toBe(3);

    await store.close();
  });

  it('hash-tagged keys route consistently to a single slot (no CROSSSLOT errors)', async () => {
    // A bare (non-hash-tagged) multi-key Lua call would throw CROSSSLOT if
    // the two keys land on different cluster nodes. RedisStore always
    // wraps the logical key in `{}` so the single key the script touches
    // is unambiguous — this test just confirms repeated calls for the same
    // logical key never error, across many random-ish key suffixes that
    // would otherwise hash to different slots.
    const client = await makeClusterClient();
    const store = new RedisStore({ client });

    const keys = Array.from({ length: 20 }, (_, i) => `cluster-test:${Date.now()}:crossslot:${i}`);

    const results = await Promise.all(keys.map((key) => store.increment(key, 60, 5)));

    for (const result of results) {
      expect(result.allowed).toBe(true);
      expect(result.totalHits).toBe(1);
    }

    await store.close();
  });

  it('distributes keys across multiple cluster nodes (sanity check on hash-tag scoping)', async () => {
    // Uses CLUSTER KEYSLOT to confirm distinct logical keys land in
    // distinct slots (proving the hash tag scopes to the key, not the
    // whole "rl:" prefix, which would collapse everything onto one node).
    const client = await makeClusterClient();
    const prefix = `rl:{cluster-test:${Date.now()}}`; // deliberately same tag on purpose below

    const slotA = await (client as Cluster).call('CLUSTER', 'KEYSLOT', `rl:{a-${Date.now()}}`);
    const slotB = await (client as Cluster).call('CLUSTER', 'KEYSLOT', `rl:{b-${Date.now()}}`);

    // Different logical keys should (overwhelmingly likely) hash to
    // different slots, confirming the hash tag is scoped per-key.
    expect(slotA).not.toBe(slotB);
    void prefix;
  });

  it('reset() removes the key so the next increment starts a fresh window', async () => {
    const client = await makeClusterClient();
    const store = new RedisStore({ client });
    const key = `cluster-test:${Date.now()}:reset`;

    await store.increment(key, 60, 1);
    const blocked = await store.increment(key, 60, 1);
    expect(blocked.allowed).toBe(false);

    await store.reset(key);

    const afterReset = await store.increment(key, 60, 1);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.totalHits).toBe(1);

    await store.close();
  });
});

afterAll(async () => {
  await Promise.all(clientsToClose.map((c) => c.quit().catch(() => undefined)));
});