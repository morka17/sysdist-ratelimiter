# distributed-rate-limiter

[![npm version](https://img.shields.io/npm/v/distributed-rate-limiter.svg)](https://www.npmjs.com/package/distributed-rate-limiter)
[![CI](https://github.com/your-org/distributed-rate-limiter/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/distributed-rate-limiter/actions)
[![Coverage](https://img.shields.io/codecov/c/github/your-org/distributed-rate-limiter)](https://codecov.io/gh/your-org/distributed-rate-limiter)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/distributed-rate-limiter.svg)](https://www.npmjs.com/package/distributed-rate-limiter)

A high-throughput, distributed rate limiter for **Express** and **Fastify**, backed by **Redis Cluster**. Implements a sliding-window algorithm executed atomically via Lua scripting, avoiding lock contention on the hot path. Benchmarked at **50,000+ req/sec** across multiple application instances sharing a single Redis Cluster.

---

## Table of Contents

- [Why This Exists](#why-this-exists)
- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [Express](#express)
  - [Fastify](#fastify)
- [Configuration Reference](#configuration-reference)
- [Algorithms](#algorithms)
- [Distributed Locking Strategy](#distributed-locking-strategy)
- [Response Headers](#response-headers)
- [Error Handling](#error-handling)
- [Custom Key Generation](#custom-key-generation)
- [Custom Stores](#custom-stores)
- [Observability](#observability)
- [Failure Modes & Fallback Behavior](#failure-modes--fallback-behavior)
- [Performance & Benchmarks](#performance--benchmarks)
- [Deployment Guide](#deployment-guide)
- [Local Development](#local-development)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Versioning & Compatibility](#versioning--compatibility)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

---

## Why This Exists

Most rate limiting middleware falls into one of two categories:

1. **In-memory limiters** — fast, but break the moment you run more than one instance behind a load balancer, since each instance has its own counter state.
2. **Naive Redis limiters** — distributed, but implemented as separate `GET` → check → `SET` round-trips, which introduces race conditions under concurrent load and collapses throughput once lock contention kicks in.

`distributed-rate-limiter` solves both problems: state lives in Redis (so all instances agree on the count), and the increment-check-expire cycle is a **single atomic Lua script execution** rather than an application-level lock. Locks are reserved for rare coordination tasks, not the request hot path, which is what allows this library to sustain tens of thousands of requests per second.

## Features

- **Sliding-window algorithm** (with optional token-bucket mode) for smooth, accurate rate limiting — no burst-at-window-boundary problem.
- **Redis Cluster support** via `ioredis`, with hash-tagged keys to keep multi-key Lua operations on a single shard.
- **Atomic operations** — no read-then-write race conditions, no per-request distributed lock overhead.
- **Express and Fastify adapters** out of the box, with a shared core so behavior is consistent across frameworks.
- **Configurable fail-open / fail-closed behavior** if Redis becomes unreachable.
- **Standard rate limit headers** (`RateLimit-*`, `Retry-After`) following the IETF draft convention.
- **Pluggable store interface** — swap Redis for another backend without touching middleware code.
- **Built-in Prometheus metrics and structured logging.**
- **Dual ESM/CJS build**, fully typed (TypeScript-first).
- **Load-tested and benchmarked**, with the test suite committed to the repo — not just marketing numbers.

## Architecture

```
Request
  │
  ▼
Middleware (express.ts / fastify.ts)
  │  - extracts key (IP / user / API key / custom)
  ▼
Core Limiter (limiter.ts)
  │  - delegates to configured algorithm
  ▼
Algorithm (sliding-window.ts)
  │  - builds Lua script call
  ▼
Store (redis-store.ts)
  │  - EVALSHA sliding-window.lua on Redis Cluster
  │  - single round-trip: trim window, add entry, count, set TTL
  ▼
Result bubbles back up
  │  - headers set (RateLimit-Limit, RateLimit-Remaining, Retry-After)
  ▼
next() or 429 RateLimitExceededError
```

Distributed locks (`Redlock`-style) are used only for non-hot-path coordination — e.g., synchronizing configuration reloads across instances — never for the per-request increment/check operation. See [Distributed Locking Strategy](#distributed-locking-strategy) for details.

Full architecture notes: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Installation

```bash
npm install distributed-rate-limiter ioredis
```

`ioredis` is a peer dependency — bring your own version to avoid duplicate Redis client instances in your dependency tree.

**Requirements:**

| Requirement | Minimum Version |
|---|---|
| Node.js | 18.x |
| Redis / Redis Cluster | 6.2+ (for `OBJECT FREQ` / Lua improvements) |
| Express | 4.x / 5.x |
| Fastify | 4.x / 5.x |

## Quick Start

### Express

```ts
import express from 'express';
import Redis from 'ioredis';
import { createExpressRateLimiter } from 'distributed-rate-limiter/express';

const redisCluster = new Redis.Cluster([
  { host: 'redis-node-1', port: 6379 },
  { host: 'redis-node-2', port: 6379 },
  { host: 'redis-node-3', port: 6379 },
]);

const limiter = createExpressRateLimiter({
  store: { client: redisCluster },
  algorithm: 'sliding-window',
  points: 100,        // max requests
  duration: 60,        // per 60 seconds
  keyPrefix: 'rl',
});

const app = express();
app.use(limiter);

app.get('/', (req, res) => res.send('ok'));
app.listen(3000);
```

### Fastify

```ts
import Fastify from 'fastify';
import Redis from 'ioredis';
import rateLimiterPlugin from 'distributed-rate-limiter/fastify';

const app = Fastify();

const redisCluster = new Redis.Cluster([
  { host: 'redis-node-1', port: 6379 },
  { host: 'redis-node-2', port: 6379 },
  { host: 'redis-node-3', port: 6379 },
]);

await app.register(rateLimiterPlugin, {
  store: { client: redisCluster },
  algorithm: 'sliding-window',
  points: 100,
  duration: 60,
});

app.get('/', async () => ({ status: 'ok' }));
await app.listen({ port: 3000 });
```

## Configuration Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `store.client` | `Redis \| Redis.Cluster` | — (required) | An `ioredis` instance or cluster client. |
| `algorithm` | `'sliding-window' \| 'token-bucket'` | `'sliding-window'` | Rate limiting algorithm. |
| `points` | `number` | `100` | Max allowed requests per window. |
| `duration` | `number` (seconds) | `60` | Length of the rate limit window. |
| `keyPrefix` | `string` | `'rl'` | Namespace prefix for Redis keys. |
| `keyGenerator` | `(req) => string` | IP-based | Custom function to derive the rate-limit key. |
| `failMode` | `'open' \| 'closed'` | `'open'` | Behavior when Redis is unreachable. See [Failure Modes](#failure-modes--fallback-behavior). |
| `skip` | `(req) => boolean` | `undefined` | Predicate to bypass limiting for a given request. |
| `headers` | `boolean` | `true` | Whether to set `RateLimit-*` response headers. |
| `onLimitExceeded` | `(req, res, info) => void` | `undefined` | Hook fired before the 429 response is sent. |
| `metrics.enabled` | `boolean` | `false` | Enables Prometheus metrics collection. |
| `metrics.registry` | `prom-client.Registry` | default registry | Custom metrics registry. |
| `logger` | `pino.Logger` | internal default | Inject your own structured logger instance. |

Options are validated at startup against a schema (`src/config/schema.ts`); invalid configuration throws immediately rather than failing silently at request time.

## Algorithms

### Sliding Window (default)

Uses a Redis sorted set per key: each request is stored as a member scored by its timestamp. On each request, the script:

1. Removes entries older than the current window (`ZREMRANGEBYSCORE`).
2. Adds the current timestamp as a new entry.
3. Counts remaining entries in the set (`ZCARD`).
4. Sets/refreshes the key TTL to the window duration.
5. Returns `allowed`, `remaining`, and `resetMs` in one round-trip.

This avoids the "thundering herd at window boundary" problem inherent to fixed-window counters, at the cost of slightly higher memory usage per key (bounded by `points`).

### Token Bucket (optional)

Available for use cases needing burst tolerance with a steady refill rate rather than a hard window cutoff. Configure via `algorithm: 'token-bucket'` with `refillRate` and `bucketSize` options — see [`docs/API.md`](./docs/API.md) for the full parameter set.

## Distributed Locking Strategy

A common misconception is that distributed rate limiting requires a distributed lock per request. It doesn't — and taking one is what kills throughput at scale.

- **Hot path (per-request increment/check):** handled entirely inside a single atomic Lua script (`EVALSHA`). Redis executes Lua scripts atomically by design, so no external lock is needed here.
- **Cold path (rare coordination):** operations like dynamic config propagation, cluster topology changes, or cache warmup use a `Redlock`-style lock (`src/store/redis/lock.ts`) to prevent multiple instances from performing the same coordination work simultaneously.

This separation is the single biggest factor in sustaining 50k+ req/sec — locking is expensive; atomic scripting is not.

## Response Headers

Following the [IETF RateLimit header fields draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/):

```
RateLimit-Limit: 100
RateLimit-Remaining: 42
RateLimit-Reset: 37
Retry-After: 37        (only present on 429 responses)
```

Disable via `headers: false` if you're implementing your own header contract.

## Error Handling

When a client exceeds their limit, the middleware throws a `RateLimitExceededError` (`src/errors/rate-limit-exceeded.error.ts`), which is caught internally and translated into a `429 Too Many Requests` response by default.

To customize the response body:

```ts
createExpressRateLimiter({
  // ...
  onLimitExceeded: (req, res, info) => {
    res.status(429).json({
      error: 'rate_limit_exceeded',
      retryAfterSeconds: info.resetMs / 1000,
    });
  },
});
```

## Custom Key Generation

By default, keys are derived from the client IP (respecting `X-Forwarded-For` when `trust proxy` is configured). Override for per-user or per-API-key limiting:

```ts
createExpressRateLimiter({
  // ...
  keyGenerator: (req) => req.headers['x-api-key'] as string ?? req.ip,
});
```

## Custom Stores

The store layer is defined by `StoreInterface` (`src/store/store.interface.ts`). While Redis is the primary supported backend, you can implement your own (e.g., DynamoDB, Memcached) by satisfying:

```ts
interface StoreInterface {
  increment(key: string, windowSeconds: number, limit: number): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}
```

A `MemoryStore` implementation is included for local development and testing — **not recommended for multi-instance production use**, since it does not share state across processes.

## Observability

Enable Prometheus metrics:

```ts
createExpressRateLimiter({
  // ...
  metrics: { enabled: true },
});
```

Exposed metrics:

| Metric | Type | Description |
|---|---|---|
| `rate_limiter_requests_total` | Counter | Labeled by `allowed`/`denied`. |
| `rate_limiter_redis_latency_ms` | Histogram | Latency of the Lua script round-trip. |
| `rate_limiter_redis_errors_total` | Counter | Redis connection/command failures. |
| `rate_limiter_fallback_total` | Counter | Times the fail-open/closed path was triggered. |

Structured logs are emitted via `pino` by default (`src/telemetry/logger.ts`), including a correlation-friendly `key`, `algorithm`, and `decision` field per request.

## Failure Modes & Fallback Behavior

Redis is a single dependency this library relies on — plan for its unavailability explicitly rather than being surprised by it.

| Mode | Behavior on Redis failure | Use when |
|---|---|---|
| `failMode: 'open'` (default) | Requests are allowed through, error logged and metric incremented | Availability matters more than strict enforcement (most APIs) |
| `failMode: 'closed'` | Requests are rejected with 503 until Redis recovers | Strict enforcement required (billing-sensitive, abuse-prone endpoints) |

Connection retry/backoff to Redis Cluster is handled by `cluster-client.ts`, including `MOVED`/`ASK` redirect handling during cluster resharding events.

## Performance & Benchmarks

Benchmarks are produced with `k6` against a 3-instance app deployment sharing a 6-node Redis Cluster (3 primaries / 3 replicas), and are committed to the repo rather than quoted from memory — see [`benchmarks/`](./benchmarks) and [`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md) for full methodology, hardware specs, and raw results.

To reproduce locally:

```bash
docker compose -f docker/docker-compose.redis-cluster.yml up -d
npm run benchmark
```

CI tracks these numbers over time; a regression beyond a defined threshold fails the build (`.github/workflows/ci.yml`).

## Deployment Guide

- **Redis Cluster sizing:** each rate-limit key uses a sorted set bounded by `points`; estimate memory as `active_keys × points × ~80 bytes`, plus TTL-driven expiry keeping steady-state usage bounded.
- **Hash tags:** keys are automatically wrapped as `{key}` so cluster slot assignment keeps all operations for a given rate-limit key on one shard — required for the Lua script to run without cross-slot errors.
- **Connection pooling:** reuse a single `ioredis` cluster client per application instance; do not instantiate a new client per request.
- **Graceful shutdown:** call `limiter.close()` (or let your Redis client's own shutdown hook run) during your app's SIGTERM handler to avoid connection leaks.
- **Multi-region:** this library assumes a single logical Redis Cluster shared by all instances enforcing the same limit. Cross-region deployments need either a globally-routed Redis Cluster or per-region limits with a wider global ceiling — there is no built-in cross-region synchronization.

## Local Development

```bash
git clone https://github.com/your-org/distributed-rate-limiter.git
cd distributed-rate-limiter
npm install
docker compose -f docker/docker-compose.redis-cluster.yml up -d
npm run dev
```

## Testing

```bash
npm run test:unit          # algorithm and lock logic, no external deps
npm run test:integration   # requires local Redis Cluster (docker compose)
npm run test:load          # k6 load test, requires local Redis Cluster
npm run test:coverage
```

CI runs unit and integration suites on every PR; load tests run on a schedule and on release branches.

## Project Structure

```
src/
├── core/            # algorithm-agnostic limiter orchestration
├── store/            # Redis (cluster + Lua scripts) and in-memory stores
├── middleware/       # Express and Fastify adapters
├── config/           # option schema and defaults
├── errors/
├── telemetry/        # metrics and logging
└── index.ts          # public API surface
```

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full breakdown including test and tooling directories.

## Versioning & Compatibility

This project follows [Semantic Versioning](https://semver.org/). Breaking changes to the public API, the Lua script contract, or default behavior are released as major versions with migration notes in [`CHANGELOG.md`](./CHANGELOG.md). Releases are automated via `semantic-release` from Conventional Commits.

## Security

If you discover a security vulnerability, please do **not** open a public issue. Email `security@your-org.com` with details; see [`SECURITY.md`](./SECURITY.md) for our disclosure policy and response timeline.

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for coding standards, commit conventions, and the PR checklist before submitting. All changes touching `store/redis/scripts/*.lua` require an accompanying integration test against a real Redis Cluster.

## License

[MIT](./LICENSE)