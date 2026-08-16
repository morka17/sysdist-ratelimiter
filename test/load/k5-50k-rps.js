/**
 * k6-50k-rps.js
 *
 * Load test intended to validate the README's "50k+ req/sec across
 * instances" claim against a real deployment (multiple app instances in
 * front of a shared Redis Cluster).
 *
 * STATUS: this script has NOT been executed against a real multi-instance
 * deployment as of this snapshot — see docs/BENCHMARKS.md for what has
 * and hasn't actually been measured, and why. `k6` itself is not
 * installable in the sandbox this codebase was developed in (its apt repo
 * isn't in the network allowlist), so this file is provided as the
 * intended methodology, not a report of results.
 *
 * Usage (once you have a real target — see TARGET_URLS below):
 *   k6 run test/load/k5-50k-rps.js
 *
 * Or, to sweep VUs while watching for the throughput ceiling:
 *   k6 run --vus 200 --duration 30s test/load/k6-50k-rps.js
 *
 * For a true "50k+ req/sec across instances" run, TARGET_URLS should list
 * every app instance's address directly (bypassing any single load
 * balancer that could itself become the bottleneck), and the app
 * instances should all be pointed at one shared Redis Cluster — not each
 * running its own isolated MemoryStore, which would trivially "pass" this
 * test without proving anything about distributed correctness.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// One URL per application instance under test. Populate via the
// TARGET_URLS environment variable (comma-separated) or edit the default
// below. Example:
//   k6 run -e TARGET_URLS=http://app1:3000,http://app2:3000,http://app3:3000 test/load/k6-50k-rps.js
const TARGET_URLS = (__ENV.TARGET_URLS || 'http://localhost:3000')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

// Spread requests across enough distinct keys that the test doesn't
// serialize on a single Redis Cluster slot (a single hot key would
// understate real-world throughput — see docs/BENCHMARKS.md).
const KEY_COUNT = Number(__ENV.KEY_COUNT || 5000);
const keys = new SharedArray('rate-limit-keys', () => {
  const arr = [];
  for (let i = 0; i < KEY_COUNT; i++) {
    arr.push(`load-test-key-${i}`);
  }
  return arr;
});

const allowedCounter = new Counter('rate_limiter_allowed_total');
const deniedCounter = new Counter('rate_limiter_denied_total');
const requestLatency = new Trend('rate_limiter_request_duration_ms', true);

export const options = {
  scenarios: {
    sustained_throughput: {
      executor: 'constant-arrival-rate',
      // The actual claim under test: sustained requests/sec. Adjust
      // `rate` upward from a conservative starting point while watching
      // `http_req_failed` and `http_req_duration` p95 for degradation —
      // don't just set this to 50000 and declare victory if error rate
      // climbs.
      rate: Number(__ENV.TARGET_RPS || 5000),
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: Number(__ENV.PRE_ALLOCATED_VUS || 500),
      maxVUs: Number(__ENV.MAX_VUS || 2000),
    },
  },
  thresholds: {
    // Fail the run (and, once wired into CI, fail the build) if these
    // regress — see docs/BENCHMARKS.md's CI-regression-tracking intent.
    http_req_failed: ['rate<0.01'], // <1% transport-level failures
    http_req_duration: ['p(95)<50', 'p(99)<150'], // ms, adjust once a real baseline exists
  },
};

function pickTargetUrl(vuId) {
  return TARGET_URLS[vuId % TARGET_URLS.length];
}

function pickKey(iterationInTest) {
  return keys[iterationInTest % keys.length];
}

export default function run() {
  const baseUrl = pickTargetUrl(__VU);
  const key = pickKey(__ITER);

  const res = http.get(`${baseUrl}/`, {
    headers: { 'x-api-key': key },
    tags: { name: 'rate_limited_endpoint' },
  });

  requestLatency.add(res.timings.duration);

  const ok = check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'has RateLimit-Limit header': (r) => r.headers['Ratelimit-Limit'] !== undefined,
  });

  if (!ok) {
    // Anything other than 200/429 (5xx, timeouts, connection errors)
    // indicates a real failure, not an expected rate-limit denial.
    console.error(`Unexpected response: status=${res.status} body=${res.body}`);
  }

  if (res.status === 200) {
    allowedCounter.add(1);
  } else if (res.status === 429) {
    deniedCounter.add(1);
  }

  // No artificial sleep — the constant-arrival-rate executor controls
  // pacing; a sleep() here would fight it rather than help.
}

export function handleSummary(data) {
  const totalRequests = (data.metrics.http_reqs && data.metrics.http_reqs.values.count) || 0;
  const durationSeconds = data.state && data.state.testRunDurationMs ? data.state.testRunDurationMs / 1000 : NaN;
  const achievedRps = durationSeconds ? Math.round(totalRequests / durationSeconds) : null;

  console.log(`\n=== Summary ===`);
  console.log(`Total requests: ${totalRequests}`);
  console.log(`Achieved req/sec: ${achievedRps}`);
  console.log(`Target instances: ${TARGET_URLS.join(', ')}`);
  console.log(`Distinct keys exercised: ${KEY_COUNT}`);

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}