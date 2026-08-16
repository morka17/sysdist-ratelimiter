# Architecture

## Layering and dependency direction

```
middleware/  →  core/  →  store/
     ↓             ↓          ↓
  config/      errors/   telemetry/
```

Strict rule: `core/` and `store/` never import from `middleware/`. `config/`, `errors/`, and
`telemetry/` are leaves — they depend on nothing else in the tree. This keeps the algorithm and
storage logic testable and reusable outside of any HTTP framework (see `examples/*-basic`, which
call `RateLimiter` directly).

## Request flow

```
1. Request arrives → framework adapter (Express middleware / Fastify onRequest hook)
2. key = keyGenerator(req)                              [middleware/shared/key-generator.ts]
3. limiter.checkLimit(key)                               [core/limiter.ts]
     a. algorithm = ALGORITHM_REGISTRY[config.algorithm]  [core/algorithms/*.ts]
     b. algorithm.consume(store, key, algorithmConfig)
          → store.increment(key, windowSeconds, limit, algorithmConfig)
               (RedisStore)  → EVALSHA sliding-window.lua on Redis/Redis Cluster
               (MemoryStore) → in-process sorted-timestamp-array equivalent
          → RateLimitResult { allowed, remaining, limit, resetMs, totalHits }
     c. metrics.recordDecision() / recordLatency()        [telemetry/metrics.ts]
4. Adapter sets RateLimit-*/Retry-After headers and returns 200 or 429
```

**Failure branch:** if `store.increment()` throws (e.g. Redis unreachable), `RateLimiter`
catches it in `checkLimit()`:
- `failMode: 'open'` (default) — logs a warning, records a fallback metric, returns a synthetic
  allowed result. The protected service stays up during a Redis outage.
- `failMode: 'closed'` — logs an error and throws `RateLimiterUnavailableError`, which the
  adapter maps to a `503`.

## Why atomicity lives in Lua, not application-level locks

The sliding-window algorithm needs to trim expired entries, record the new request, count the
window, and set a TTL — four operations that must happen as one unit or concurrent requests
race each other. Two ways to make that atomic:

1. Take a distributed lock, do the four operations, release the lock.
2. Push all four operations into Redis as a single Lua script (`sliding-window.lua`),
   executed via `EVALSHA` in one network round-trip.

This project uses (2) exclusively for the per-request hot path. Redis executes Lua scripts
atomically by design — no other command runs on that Redis node while the script executes — so
no external lock is needed, and there's no lock-acquire/release round-trip tax on every request.
`DistributedLock` (`store/redis/lock.ts`) exists in this codebase but is reserved for rare,
non-hot-path coordination (e.g. a future config-sync feature) — it is never called from
`RateLimiter.checkLimit()`.

## `sliding-window.lua`, concretely

Given `KEYS[1]` (a hash-tagged key), `ARGV[1]` (window seconds), `ARGV[2]` (limit), `ARGV[3]`
(the app-supplied epoch-ms timestamp):

1. `ZREMRANGEBYSCORE key -inf windowStartMs` — evict entries older than the window.
2. `ZADD key nowMs "<nowMs>-<random>"` — record this request. The random suffix disambiguates
   requests that land on the same millisecond so they don't overwrite each other in the set.
3. `ZCARD key` — count entries in the window, post-add.
4. `PEXPIRE key windowMs` — bound the key's lifetime so abandoned keys self-clean.
5. Return `{ allowed, remaining, limit, resetMs, totalHits }` as a flat array.

`nowMs` is supplied by the calling application (`Date.now()` in `RedisStore`) rather than read
via Redis's `TIME` command, so the decision doesn't depend on individual node clock skew across
a cluster.

## Redis Cluster key routing

Keys are wrapped as `` `${prefix}:{${key}}` `` (a Redis hash tag) before being sent to Redis.
Redis Cluster computes the hash slot from only the substring inside `{}`, so this guarantees the
sorted set the Lua script reads/writes always lives on a single slot/node — required for the
script to execute without a `CROSSSLOT` error. See `buildHashTaggedKey()` in
`store/redis/redis-store.ts`.

## Script registration: `defineCommand`, not hand-rolled EVALSHA

`RedisStore` registers the Lua script once per client via ioredis's `client.defineCommand()`
rather than manually calling `SCRIPT LOAD` + `EVALSHA` + catching `NOSCRIPT`. `defineCommand`
handles the EVALSHA/NOSCRIPT-retry dance internally and exposes the script as an ordinary async
method (`client.rlSlidingWindow(...)`). This removes a category of hand-rolled-retry bugs at the
cost of one indirection layer.

## Store contract and interchangeability

`RedisStore` and `MemoryStore` both implement `StoreInterface` and are exercised by the same
contract test suite (`test/integration/store-contract.test.ts`) so their behavior — allow/deny
thresholds, `remaining` clamping, per-key isolation, `reset()` semantics — stays identical.
`MemoryStore` is documented as unsuitable for multi-instance production (state is per-process),
but is exactly what local development and the bundled examples use by default so they run with
zero external dependencies.

## Config resolution

`config/schema.ts` defines the raw, mostly-optional `RateLimiterOptions` type and validates it
with `zod`. `config/defaults.ts#resolveConfig()` is the single place default values are applied
(`DEFAULT_OPTIONS`), producing a fully-populated `ResolvedRateLimiterConfig` that every internal
consumer depends on. No other file should inline a fallback for one of these fields — this
keeps "what happens if the user doesn't specify X" answerable by reading one file.

## Observability

`Logger` and `MetricsRecorder` are interfaces, not concrete `pino`/`prom-client` types, so
injecting a custom implementation never forces those packages on a consumer who doesn't want
them. `telemetry/logger.ts` ships a dependency-free structured-JSON default; `telemetry/metrics.ts`
ships an in-process `InMemoryMetricsRecorder`. A Prometheus-backed `MetricsRecorder` can be
supplied via `RateLimiter`'s constructor `deps` without touching `core/limiter.ts`.