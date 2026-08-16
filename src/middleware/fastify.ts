import type { RateLimiterOptions } from '../config/schema.js';
import { RateLimiterUnavailableError } from '../errors/rate-limit-exceeded.error.js';
import { createLimiterBundle } from './shared/create-limiter.js';
import type { MinimalRequest } from './shared/key-generator.js';
import {
  applyRateLimitHeaders,
  applyRetryAfterHeader,
  type RateLimitHeaderSink,
} from './shared/response-header.js';

/** Duck-typed Fastify instance — no hard dependency on `fastify` types. */
export interface FastifyInstance {
  addHook(
    name: 'onRequest',
    hook: (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>,
  ): void;
}

export interface FastifyRequest extends MinimalRequest {
  readonly ip: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface FastifyReply extends RateLimitHeaderSink {
  status(code: number): FastifyReply;
  send(payload?: unknown): FastifyReply | void;
  header(name: string, value: string | number): FastifyReply;
}

export type FastifyRateLimiterPlugin = (
  fastify: FastifyInstance,
  options: RateLimiterOptions,
) => void | Promise<void>;

/**
 * Fastify plugin (register via `app.register(rateLimiterPlugin, options)`).
 * Decorated with `fastify-plugin` semantics so hooks apply to nested scopes.
 */
const rateLimiterPlugin: FastifyRateLimiterPlugin = async (fastify, options) => {
  const { config, limiter } = createLimiterBundle(options);

  fastify.addHook('onRequest', async (request, reply) => {
    try {
      if (config.skip?.(request)) {
        return;
      }

      const key = config.keyGenerator(request);
      const result = await limiter.checkLimit(key);

      if (config.headers) {
        applyRateLimitHeaders(reply, result);
        if (!result.allowed) {
          applyRetryAfterHeader(reply, result);
        }
      }

      if (!result.allowed) {
        if (config.onLimitExceeded !== undefined) {
          config.onLimitExceeded(request, reply, result);
          return;
        }

        reply.status(429).send({ error: 'rate_limit_exceeded' });
        return;
      }
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) {
        reply.status(503).send({ error: 'rate_limiter_unavailable' });
        return;
      }

      throw error;
    }
  });
};

(rateLimiterPlugin as unknown as { [key: symbol]: boolean })[Symbol.for('skip-override')] = true;

export default rateLimiterPlugin;
