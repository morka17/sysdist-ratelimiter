/**
 * Minimal surface area of an ioredis client used by `RedisStore`.
 * Typed locally so `ioredis` can remain a peer dependency.
 */
export interface RedisScriptClient {
  evalsha(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  script(command: 'LOAD', source: string): Promise<string>;
  del(...keys: string[]): Promise<number>;
  quit(): Promise<string>;
  disconnect?(): void;
}

export interface ClusterNodeAddress {
  readonly host: string;
  readonly port: number;
}

export interface CreateClusterClientOptions {
  readonly nodes: readonly ClusterNodeAddress[];
  readonly redisOptions?: Record<string, unknown>;
  /**
   * Mirrors ioredis' `clusterRetryStrategy`. Return `null` to stop retrying.
   * Defaults to exponential backoff capped at 2s.
   */
  readonly clusterRetryStrategy?: (times: number) => number | null;
}

type IoRedisClusterConstructor = new (
  nodes: ClusterNodeAddress[],
  options?: Record<string, unknown>,
) => RedisScriptClient;

const DEFAULT_CLUSTER_RETRY_STRATEGY = (times: number): number => Math.min(times * 100, 2000);

/**
 * Creates an `ioredis` cluster client with retry/backoff defaults suited to
 * rate-limiter workloads. `MOVED`/`ASK` redirect handling is built into
 * ioredis itself — this wrapper only standardizes connection options.
 */
export async function createClusterClient(
  options: CreateClusterClientOptions,
): Promise<RedisScriptClient> {
  const ioredisModule = (await import('ioredis')) as unknown as {
    default?: { Cluster?: IoRedisClusterConstructor };
    Cluster?: IoRedisClusterConstructor;
  };

  const Cluster = ioredisModule.default?.Cluster ?? ioredisModule.Cluster;
  if (Cluster === undefined) {
    throw new Error('ioredis.Cluster is not available — install the ioredis peer dependency');
  }

  return new Cluster([...options.nodes], {
    redisOptions: options.redisOptions,
    clusterRetryStrategy: options.clusterRetryStrategy ?? DEFAULT_CLUSTER_RETRY_STRATEGY,
    enableReadyCheck: true,
    maxRedirections: 16,
  }) as RedisScriptClient;
}
