// --- Core ---
export { RateLimiter, type RateLimiterDeps } from './core/limiter.js';
export { buildRateLimitResult, type RateLimitResult } from './core/result.js';

export {
  SLIDING_WINDOW_ALGORITHM_NAME,
  SlidingWindowAlgorithm,
} from './core/algorithms/sliding_window.js';
export {
  TOKEN_BUCKET_ALGORITHM_NAME,
  TokenBucketAlgorithm,
  isTokenBucketConfig,
  type TokenBucketConfig,
} from './core/algorithms/token_bucket.js';
export {
  type AlgorithmConfig,
  type RateLimitAlgorithm,
} from './core/algorithms/algorithm.interface.js';

// --- Config ---
export { resolveConfig, DEFAULT_OPTIONS } from './config/default.js';
export {
  rateLimiterOptionsSchema,
  type KeyGenerator,
  type RateLimiterOptions,
  type ResolvedRateLimiterConfig,
} from './config/schema.js';

// --- Stores ---
export type { StoreInterface } from './store/interface.store.js';
export { MemoryStore } from './store/memory-store.js';
export { RedisStore, type RedisStoreOptions } from './store/redis/redis-store.js';
export {
  createClusterClient,
  type ClusterNodeAddress,
  type CreateClusterClientOptions,
  type RedisScriptClient,
} from './store/redis/cluster-client.js';

// --- Middleware ---
export {
  createExpressRateLimiter,
  type ExpressRateLimitMiddleware,
  type ExpressNextFunction,
  type ExpressRequest,
  type ExpressResponse,
} from './middleware/express.js';
export { default as rateLimiterPlugin } from './middleware/fastify.js';
export {
  type FastifyInstance,
  type FastifyRateLimiterPlugin,
  type FastifyReply,
  type FastifyRequest,
} from './middleware/fastify.js';
export { createLimiterBundle, type LimiterBundle } from './middleware/shared/create-limiter.js';
export {
  DEFAULT_KEY_GENERATOR,
  type MinimalRequest,
} from './middleware/shared/key-generator.js';
export {
  applyRateLimitHeaders,
  applyRetryAfterHeader,
  type RateLimitHeaderSink,
} from './middleware/shared/response-header.js';

// --- Errors ---
export {
  RateLimitExceededError,
  RateLimiterUnavailableError,
} from './errors/rate-limit-exceeded.error.js';

// --- Telemetry ---
export { createDefaultLogger, type Logger } from './telemetry/logger.js';
export {
  createMetricsRecorder,
  createNoopMetricsRecorder,
  InMemoryMetricsRecorder,
  METRIC_FALLBACK_TOTAL,
  METRIC_REDIS_ERRORS_TOTAL,
  METRIC_REDIS_LATENCY_MS,
  METRIC_REQUESTS_TOTAL,
  type MetricsRecorder,
  type MetricsSnapshot,
} from './telemetry/metrics.js';
