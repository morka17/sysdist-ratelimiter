# Benchmarks

## Status

The full multi-instance, Redis-Cluster-backed load test described in the README (`k6`, 3 app
instances, a 6-node Redis Cluster) is **not yet implemented** in this snapshot — `benchmarks/`
and `test/load/k6-50k-rps.js` are still on the roadmap. This document exists so the README's
throughput claim isn't left unverified; it records what has and hasn't actually been measured
yet, and the methodology the eventual harness should follow.

## What has been measured so far

A quick, single-process microbenchmark was run directly against `RedisStore`'s Lua script (via
`client.rlSlidingWindow(...)`, bypassing HTTP entirely) on a single local Redis instance:

| Parameter | Value |
|---|---|
| Redis version | 7.0.15, single node, default config, `appendonly no` |
| Client | 1 Node.js process (v22.22.2), `ioredis`, 50 concurrent in-flight calls |
| Connection | loopback (`127.0.0.1`), no network hop |
| Script | the actual `sliding-window.lua` shipped in `store/redis/scripts/` |
| Duration | 3 seconds |

**Result: ~46,900 ops/sec** sustained from a single Node process against a single Redis
instance over loopback.

### How to interpret this number

- This is a **directional sanity check**, not the claimed benchmark. It confirms the atomic
  Lua-script approach doesn't have some obvious bottleneck that caps it far below the target —
  a single process, single Redis node, loopback connection is already approaching 50k ops/sec.
- It is **not** evidence for "50k+ req/sec across multiple app instances sharing a Redis
  Cluster over a real network," which is the actual README claim. That requires the full
  harness described below.
- It does not account for: real network latency between app and Redis, HTTP request overhead
  (routing, header parsing, middleware stack), multiple concurrent app instances contending
  for the same Redis Cluster, or Redis Cluster's own cross-node overhead (MOVED/ASK handling,
  hash slot lookups).

Reproduce it yourself:

```js
// direct-script-bench.mjs (ad hoc, not part of the checked-in suite yet)
import Redis from 'ioredis';
const client = new Redis();
client.defineCommand('rlSlidingWindow', { numberOfKeys: 1, lua: /* contents of sliding-window.lua */ });
// issue N concurrent client.rlSlidingWindow(key, '60', '1000000', String(Date.now())) calls
// for a fixed duration and count completions.
```

## Methodology for the real claim (not yet run)

To honestly back the README's "50k+ req/sec across instances" claim, the eventual
`test/load/k6-50k-rps.js` harness needs:

1. **Topology**: at least 2–3 application instances (each running the full HTTP stack —
   Express/Fastify + this library's middleware, not a bare script) behind a load balancer or
   hit directly and aggregated, all pointed at one shared **Redis Cluster** (not a single node)
   — ideally 3 primaries / 3 replicas, matching the README's stated setup.
2. **Load generator**: `k6` (or `autocannon`) running from a separate machine/process from both
   the app instances and Redis, so client-side CPU doesn't bottleneck the measurement.
3. **Workload**: requests distributed across enough distinct rate-limit keys that the test
   exercises realistic key cardinality (a single hot key serializes at the Redis slot level and
   would understate real-world throughput; too many keys with too-short a window undersells
   the sliding-window log's steady-state size).
4. **Metrics captured**: aggregate requests/sec across all instances, p50/p95/p99 latency,
   error rate, and Redis-side metrics (`INFO commandstats`, CPU) to confirm Redis isn't
   silently the bottleneck at the claimed rate.
5. **CI regression tracking**: once a baseline is established, subsequent runs should fail CI
   if throughput regresses beyond an agreed threshold (e.g. >10% drop), per the project
   structure's intent (`.github/workflows/ci.yml`) — not yet wired up.

## Honesty note for anyone extending this doc

Do not backfill this file with invented multi-instance/cluster numbers. When the real harness
is built and run, replace this document's "Status" section with actual results, the exact
hardware/instance types used, and a link to the raw `k6` output — the same way the single-node
number above is reported with its caveats attached.