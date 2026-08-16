declare module 'ioredis' {
  import type { RedisScriptClient } from '../store/redis/cluster-client.js';

  interface RedisCommandClient {
    set(
      key: string,
      value: string,
      expiryMode: 'PX',
      ttlMs: number,
      setMode: 'NX',
    ): Promise<'OK' | null>;
    defineCommand(
      name: string,
      definition: { numberOfKeys: number; lua: string },
    ): void;
    get(key: string): Promise<string | null>;
  }

  export default class Redis implements RedisCommandClient {
    static Cluster: new (
      nodes: Array<{ host: string; port: number }>,
      options?: Record<string, unknown>,
    ) => RedisScriptClient & RedisCommandClient;

    constructor(url?: string, options?: Record<string, unknown>);
    connect(): Promise<void>;
    ping(): Promise<string>;
    quit(): Promise<string>;
    on(event: 'error', listener: (...args: unknown[]) => void): this;

    set(
      key: string,
      value: string,
      expiryMode: 'PX',
      ttlMs: number,
      setMode: 'NX',
    ): Promise<'OK' | null>;
    defineCommand(
      name: string,
      definition: { numberOfKeys: number; lua: string },
    ): void;
    get(key: string): Promise<string | null>;
  }

  export class Cluster implements RedisCommandClient {
    constructor(
      nodes: Array<{ host: string; port: number }>,
      options?: Record<string, unknown>,
    );

    connect(): Promise<void>;
    ping(): Promise<string>;
    quit(): Promise<string>;
    on(event: 'error', listener: (...args: unknown[]) => void): this;
    call(...args: unknown[]): Promise<unknown>;

    set(
      key: string,
      value: string,
      expiryMode: 'PX',
      ttlMs: number,
      setMode: 'NX',
    ): Promise<'OK' | null>;
    defineCommand(
      name: string,
      definition: { numberOfKeys: number; lua: string },
    ): void;
    get(key: string): Promise<string | null>;
  }
}
