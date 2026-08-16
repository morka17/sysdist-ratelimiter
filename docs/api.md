# API Reference

This reflects the public surface actually implemented in this snapshot (`src/index.ts`).
Framework adapters (`distributed-rate-limiter/express`, `distributed-rate-limiter/fastify`) are
**not yet built** — see `examples/*-basic` for the equivalent wiring pattern using the core
`RateLimiter` directly until those adapters land.

## `RateLimiter`

```ts
import { RateLimiter } from 'distributed-rate-limiter';

new RateLimiter(config: ResolvedRateLimiterConfig, store: StoreInterface, deps?: RateLimiterDeps)
```

| Param | Type | Notes |
|---|---|---|
| `config` | `ResolvedRateLimiterConfig` | Produce via `resolveConfig(options)` — don't hand-build this. |
| `store` | `StoreInterface` | `new MemoryStore()` or `new RedisStore({ client })`. |
| `deps.logger` | `Logger` | Optional. Defaults to `createDefaultLogger()`. |
| `deps.metrics` | `MetricsRecorder` | Optional. Defaults to a no-op recorder. |

**Methods:**

- **`checkLimit(key: string): Promise<RateLimitResult>`** — records one hit for `key` and
  returns the decision. Never rejects for an "over limit" outcome (`result.allowed === false`
  is the expected signal). Rejects with `RateLimiterUnavailableError` only when the store is
  unreachable and `config.failMode === 'closed'`.
- **`reset(key: string): Promise<void>`** — clears all state for `key`.
- **`close(): Promise<void>`** — tears down the underlying store connection. Call this in your
  shutdown handler (`SIGTERM`, etc.).

Throws synchronously at construction time (not at first request) if `config.algorithm` isn't
registered, or if `algorithm === 'token-bucket'` and `refillRate`/`bucketSize` are missing.

## `resolveConfig(options: RateLimiterOptions): ResolvedRateLimiterConfig`

The single place defaults are applied and validated (via `zod`). Throws a descriptive error
immediately on invalid input — call this once at startup, not per request.

```ts
import { resolveConfig } from 'distributed-rate-limiter';

const config = resolveConfig({
  store: {},               // keyPrefix defaults to 'rl'
  algorithm: 'sliding-window', // or 'token-bucket'
  points: 100,
  duration: 60,             // seconds
  failMode: 'open',         // or 'closed'
});
```

### `RateLimiterOptions` fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `store.client` | `unknown` | — | Passed through to `RedisStore`/your own store construction; not read by `resolveConfig` itself. |
| `store.type` | `'redis' \| 'memory'` | `'redis'` | Informational; you still construct the concrete store yourself. |
| `store.keyPrefix` | `string` | `'rl'` | Namespace prefix used to build hash-tagged Redis keys. |
| `algorithm` | `'sliding-window' \| 'token-bucket'` | `'sliding-window'` | |
| `points` | `number` | `100` | Max requests per window (sliding-window). |
| `duration` | `number` (seconds) | `60` | Window length (sliding-window). |
| `refillRate` | `number` | — | **Required** if `algorithm === 'token-bucket'`. Tokens/sec. |
| `bucketSize` | `number` | — | **Required** if `algorithm === 'token-bucket'`. Max tokens. |
| `keyGenerator` | `(req: MinimalRequest) => string` | IP-based | See `middleware/shared/key-generator.ts`. |
| `failMode` | `'open' \| 'closed'` | `'open'` | Behavior when the store throws. |
| `headers` | `boolean` | `true` | Not yet consumed by this snapshot (no adapter reads it) — reserved for the framework adapters. |
| `metrics.enabled` | `boolean` | `false` | Enables `InMemoryMetricsRecorder` if you construct `RateLimiter` without your own `deps.metrics`. |
| `logger` | `unknown` | — | Not currently threaded into `RateLimiter` automatically; pass a `Logger` via `deps.logger` instead. |

## `StoreInterface`

```ts
interface StoreInterface {
  increment(key: string, windowSeconds: number, limit: number, algorithmConfig?: AlgorithmConfig): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
  close(): Promise<void>;
}
```

Two implementations ship in this snapshot:

### `MemoryStore`

```ts
import { MemoryStore } from 'distributed-rate-limiter';
const store = new MemoryStore();
```

No constructor arguments. Per-process state only — see the README/ARCHITECTURE.md caveats
about multi-instance production use.

### `RedisStore`

```ts
import { RedisStore, createClusterClient } from 'distributed-rate-limiter';

const client = createClusterClient({ nodes: [{ host: 'redis-1', port: 6379 }] });
const store = new RedisStore({ client, keyPrefix: 'rl' });
```

| Option | Type | Default | Notes |
|---|---|---|---|
| `client` | `Redis \| Cluster` (ioredis) | — required | Bring your own `ioredis` instance, or use `createClusterClient`. |
| `keyPrefix` | `string` | `'rl'` | Overridable per-call via `AlgorithmConfig.keyPrefix`. |
| `logger` | `Logger` | default | |

`increment()` registers the sliding-window Lua script on the client (once, via
`defineCommand`) and executes it atomically. See `docs/ARCHITECTURE.md` for the script's
exact contract.

## `createClusterClient(options: ClusterClientOptions): Cluster`

```ts
createClusterClient({
  nodes: [{ host: 'redis-1', port: 6379 }, { host: 'redis-2', port: 6379 }],
  redisOptions: { password: '...' }, // optional, passed through to ioredis
})
```

The only place this package constructs a `Redis.Cluster` — centralizes retry/backoff
(`min(times*100, 2000)`ms) and redirect handling (`maxRedirections: 16`).

## `RateLimitResult`

```ts
interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetMs: number;
  totalHits: number;
}
```

`remaining` is always `Math.max(0, limit - totalHits)` — build one via `buildRateLimitResult()`
if you're implementing a custom `StoreInterface`, rather than computing it by hand.

## Errors

```ts
import { RateLimitExceededError, RateLimiterUnavailableError } from 'distributed-rate-limiter';
```

- **`RateLimitExceededError`** — not currently thrown by `RateLimiter` itself (`checkLimit()`
  returns `{ allowed: false, ... }` instead of throwing). It's exported for adapters/consumers
  that prefer a throw-based control flow (e.g. inside Fastify hooks) — see
  `examples/fastify-basic`.
- **`RateLimiterUnavailableError`** — thrown by `checkLimit()` when the store fails and
  `failMode: 'closed'`. Carries the original error as `.cause`.

## Algorithms (advanced / custom store implementers)

`SlidingWindowAlgorithm` and `TokenBucketAlgorithm` (both exported from
`core/algorithms/index.ts`, not yet re-exported from the root barrel) are thin adapters — they
validate their config and delegate to `store.increment()`. You generally don't construct these
directly; `RateLimiter` does, based on `config.algorithm`. They're documented here for anyone
implementing a custom `StoreInterface` that needs to branch on algorithm shape — see
`isTokenBucketConfig()` for the detection helper used by `RedisStore`.