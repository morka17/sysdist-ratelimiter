declare module 'ioredis' {
  import type { RedisScriptClient } from '../store/redis/cluster-client.js';

  export default class Redis {
    static Cluster: new (
      nodes: Array<{ host: string; port: number }>,
      options?: Record<string, unknown>,
    ) => RedisScriptClient;
  }

  export class Cluster {
    constructor(
      nodes: Array<{ host: string; port: number }>,
      options?: Record<string, unknown>,
    );
  }
}
