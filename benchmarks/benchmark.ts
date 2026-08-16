#!/usr/bin/env tsx
/**
 * benchmarks/benchmark.ts
 *
 * Throughput/latency benchmark for the distributed rate limiter stores.
 * Runs `store.increment()` under concurrent load and reports ops/sec plus
 * p50/p95/p99 latency for each backend that's enabled/reachable.
 *
 * Usage:
 *   npx tsx benchmarks/benchmark.ts
 *   npx tsx benchmarks/benchmark.ts --ops 50000 --concurrency 100
 *
 * Env (.env is loaded automatically):
 *   REDIS_URL          redis://user:pass@host:port  (single-node)
 *   USE_REDIS           "true" to run the single-node Redis benchmark
 *   USE_REDIS_CLUSTER    "true" to run the cluster benchmark
 *   CLUSTER_NODES       "host:port,host:port,..." (defaults to 127.0.0.1:7000-7002)
 */

import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import Redis from 'ioredis';
import { createClusterClient, type RedisScriptClient } from '../src/store/redis/cluster-client.js';
import { RedisStore } from '../src/store/redis/redis-store.js';
import { MemoryStore } from '../src/store/memory-store.js';

interface IncrementResult {
  allowed: boolean;
  totalHits: number;
}

interface RateLimitStore {
  increment(key: string, duration: number, limit: number): Promise<IncrementResult>;
  reset(key: string): Promise<void>;
  close?(): Promise<void>;
}

interface BenchmarkConfig {
  ops: number;
  concurrency: number;
  keySpace: number;
  duration: number;
  limit: number;
  warmupOps: number;
}

interface BenchmarkResult {
  name: string;
  ops: number;
  errors: number;
  totalMs: number;
  opsPerSec: number;
  latency: { mean: number; p50: number; p95: number; p99: number; max: number };
}

const DEFAULT_CONFIG: BenchmarkConfig = {
  ops: 20_000,
  concurrency: 50,
  keySpace: 500,
  duration: 60,
  // Set high so increment() rarely takes the "blocked" branch — we're
  // benchmarking store overhead, not lockout logic.
  limit: 1_000_000,
  warmupOps: 500,
};

function parseArgs(argv: string[]): Partial<BenchmarkConfig> {
  const out: Partial<BenchmarkConfig> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => Number(argv[++i]);
    if (arg === '--ops') out.ops = next();
    else if (arg === '--concurrency') out.concurrency = next();
    else if (arg === '--key-space') out.keySpace = next();
    else if (arg === '--duration') out.duration = next();
    else if (arg === '--limit') out.limit = next();
    else if (arg === '--warmup') out.warmupOps = next();
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function randomKey(prefix: string, keySpace: number): string {
  return `bench:${prefix}:${Math.floor(Math.random() * keySpace)}`;
}

async function runOnce(
  store: RateLimitStore,
  key: string,
  duration: number,
  limit: number,
): Promise<{ ms: number; error: boolean }> {
  const start = performance.now();
  try {
    await store.increment(key, duration, limit);
    return { ms: performance.now() - start, error: false };
  } catch {
    return { ms: performance.now() - start, error: true };
  }
}

async function benchmarkStore(
  name: string,
  store: RateLimitStore,
  config: BenchmarkConfig,
): Promise<BenchmarkResult> {
  // Warm up: prime connections / JIT, discard timings.
  for (let i = 0; i < config.warmupOps; i++) {
    await runOnce(store, randomKey(name, config.keySpace), config.duration, config.limit);
  }

  const latencies: number[] = [];
  let errors = 0;
  let dispatched = 0;

  const start = performance.now();

  async function worker() {
    while (dispatched < config.ops) {
      dispatched++;
      const key = randomKey(name, config.keySpace);
      const { ms, error } = await runOnce(store, key, config.duration, config.limit);
      latencies.push(ms);
      if (error) errors++;
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));

  const totalMs = performance.now() - start;
  latencies.sort((a, b) => a - b);

  return {
    name,
    ops: config.ops,
    errors,
    totalMs,
    opsPerSec: config.ops / (totalMs / 1000),
    latency: {
      mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] ?? 0,
    },
  };
}

function printResults(results: BenchmarkResult[]): void {
  console.log('\nBenchmark results\n' + '='.repeat(80));
  console.table(
    results.map((r) => ({
      Store: r.name,
      Ops: r.ops,
      Errors: r.errors,
      'Ops/sec': r.opsPerSec.toFixed(0),
      'Mean (ms)': r.latency.mean.toFixed(3),
      'p50 (ms)': r.latency.p50.toFixed(3),
      'p95 (ms)': r.latency.p95.toFixed(3),
      'p99 (ms)': r.latency.p99.toFixed(3),
      'Max (ms)': r.latency.max.toFixed(3),
      'Total (s)': (r.totalMs / 1000).toFixed(2),
    })),
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function main() {
  const config: BenchmarkConfig = { ...DEFAULT_CONFIG, ...parseArgs(process.argv.slice(2)) };
  console.log('Config:', config);

  const results: BenchmarkResult[] = [];
  const teardowns: Array<() => Promise<void>> = [];

  // --- Memory store -----------------------------------------------------
  try {
    const memoryStore = new MemoryStore() as unknown as RateLimitStore;
    results.push(await benchmarkStore('memory', memoryStore, config));
    if (typeof memoryStore.close === 'function') {
      teardowns.push(() => memoryStore.close!());
    }
  } catch (err) {
    console.error('Skipping memory benchmark:', (err as Error).message);
  }

  // --- Single-node Redis --------------------------------------------------
  const redisUrl = process.env.REDIS_URL;
  const useRedis = process.env.USE_REDIS === 'true' || process.env.USER_REDIS === 'true';

  if (useRedis && redisUrl) {
    let client: Redis | undefined;
    try {
      client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await withTimeout(client.connect(), 5000, 'Redis connect');
      await withTimeout(client.ping(), 5000, 'Redis ping');

      const redisStore = new RedisStore({ client: client as unknown as RedisScriptClient });
      results.push(await benchmarkStore('redis (single node)', redisStore as unknown as RateLimitStore, config));
      teardowns.push(() => redisStore.close());
    } catch (err) {
      console.error('Skipping single-node Redis benchmark:', (err as Error).message);
      await client?.quit().catch(() => undefined);
    }
  } else {
    console.log('Skipping single-node Redis benchmark (set REDIS_URL and USE_REDIS=true to enable).');
  }

  // --- Redis Cluster --------------------------------------------------
  if (process.env.USE_REDIS_CLUSTER === 'true') {
    const nodesEnv = process.env.CLUSTER_NODES ?? '127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002';
    const nodes = nodesEnv.split(',').map((entry) => {
      const [host, port] = entry.split(':');
      return { host, port: Number(port) };
    });

    try {
      const clusterClient = await withTimeout(createClusterClient({ nodes }), 5000, 'Cluster connect');
      const clusterStore = new RedisStore({ client: clusterClient });
      results.push(await benchmarkStore('redis (cluster)', clusterStore as unknown as RateLimitStore, config));
      teardowns.push(async () => {
        await clusterStore.close();
        await clusterClient.quit().catch(() => undefined);
      });
    } catch (err) {
      console.error('Skipping Redis Cluster benchmark:', (err as Error).message);
    }
  } else {
    console.log('Skipping Redis Cluster benchmark (set USE_REDIS_CLUSTER=true to enable).');
  }

  printResults(results);

  await Promise.all(teardowns.map((fn) => fn().catch(() => undefined)));
  process.exit(0);
}

main().catch((err) => {
  console.error('Benchmark run failed:', err);
  process.exit(1);
});