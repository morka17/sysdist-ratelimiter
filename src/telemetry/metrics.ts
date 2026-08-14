/**
 * Facade the rest of the codebase depends on instead of importing
 * `prom-client` types directly, so a metrics library stays optional and
 * swappable (Prometheus, StatsD, OpenTelemetry, or none at all).
 */
export interface MetricsRecorder {
    recordDecision(allowed: boolean): void;
    recordLatency(ms: number): void;
    recordRedisError(): void;
    recordFallback(): void;
  }
  
  /** Metric name constants — kept here so any future prom-client-backed
   * implementation of MetricsRecorder registers metrics under these exact
   * names, matching what's documented in the README. */
  export const METRIC_REQUESTS_TOTAL = 'rate_limiter_requests_total';
  export const METRIC_REDIS_LATENCY_MS = 'rate_limiter_redis_latency_ms';
  export const METRIC_REDIS_ERRORS_TOTAL = 'rate_limiter_redis_errors_total';
  export const METRIC_FALLBACK_TOTAL = 'rate_limiter_fallback_total';
  
  /** A MetricsRecorder that discards everything. Used when metrics are disabled. */
  export function createNoopMetricsRecorder(): MetricsRecorder {
    return {
      recordDecision: () => undefined,
      recordLatency: () => undefined,
      recordRedisError: () => undefined,
      recordFallback: () => undefined,
    };
  }
  
  /** Snapshot shape returned by InMemoryMetricsRecorder.snapshot(), useful for tests/introspection. */
  export interface MetricsSnapshot {
    allowedTotal: number;
    deniedTotal: number;
    redisErrorsTotal: number;
    fallbackTotal: number;
    latencySamplesMs: readonly number[];
  }
  
  /**
   * Minimal in-process MetricsRecorder with no external dependency. Suitable
   * as the default when `config.metrics.enabled` is true but no `registry`
   * (e.g. a `prom-client.Registry`) is supplied. Production deployments that
   * want Prometheus scraping should inject a `MetricsRecorder` backed by
   * `prom-client` via `config.metrics.registry` / a custom adapter — this
   * class exists so metrics collection works out of the box without forcing
   * that dependency on every consumer.
   */
  export class InMemoryMetricsRecorder implements MetricsRecorder {
    private allowedTotal = 0;
    private deniedTotal = 0;
    private redisErrorsTotal = 0;
    private fallbackTotal = 0;
    private readonly latencySamplesMs: number[] = [];
  
    public recordDecision(allowed: boolean): void {
      if (allowed) {
        this.allowedTotal += 1;
      } else {
        this.deniedTotal += 1;
      }
    }
  
    public recordLatency(ms: number): void {
      this.latencySamplesMs.push(ms);
    }
  
    public recordRedisError(): void {
      this.redisErrorsTotal += 1;
    }
  
    public recordFallback(): void {
      this.fallbackTotal += 1;
    }
  
    public snapshot(): MetricsSnapshot {
      return {
        allowedTotal: this.allowedTotal,
        deniedTotal: this.deniedTotal,
        redisErrorsTotal: this.redisErrorsTotal,
        fallbackTotal: this.fallbackTotal,
        latencySamplesMs: [...this.latencySamplesMs],
      };
    }
  }
  
  /**
   * Factory used by middleware adapters: `createMetricsRecorder(config.metrics)`.
   * Returns a no-op recorder when metrics are disabled, otherwise an
   * in-memory recorder. `registry` is accepted (typed `unknown`) as the
   * extension point for a future prom-client-backed adapter without
   * changing this function's signature.
   */
  export function createMetricsRecorder(options?: { enabled?: boolean; registry?: unknown }): MetricsRecorder {
    if (!options?.enabled) {
      return createNoopMetricsRecorder();
    }
    return new InMemoryMetricsRecorder();
  }