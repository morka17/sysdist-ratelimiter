import { describe, it, expect, vi } from 'vitest';
import rateLimiterPlugin, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '../../src/middleware/fastify.js';

type OnRequestHook = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

function createMockFastify(): FastifyInstance & { onRequestHook: OnRequestHook | undefined } {
  const fastify = {
    onRequestHook: undefined as OnRequestHook | undefined,
    addHook(name: 'onRequest', hook: OnRequestHook) {
      if (name === 'onRequest') {
        this.onRequestHook = hook;
      }
    },
  };

  return fastify;
}

function makeReply() {
  const headers: Record<string, string | number> = {};
  const reply: FastifyReply = {
    setHeader(name, value) {
      headers[name] = value;
      return reply;
    },
    header(name, value) {
      headers[name] = value;
      return reply;
    },
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };

  return { reply, headers };
}

describe('Fastify integration', () => {
  it('registers an onRequest hook that allows requests under the limit', async () => {
    const fastify = createMockFastify();

    await rateLimiterPlugin(fastify, {
      store: { type: 'memory' },
      points: 2,
      duration: 60,
    });

    expect(fastify.onRequestHook).toBeTypeOf('function');

    const req = { ip: '127.0.0.1', headers: {} };
    const { reply, headers } = makeReply();

    await fastify.onRequestHook!(req, reply);

    expect(reply.status).not.toHaveBeenCalled();
    expect(headers['RateLimit-Limit']).toBe(2);
    expect(headers['RateLimit-Remaining']).toBe(1);
  });

  it('returns 429 once the limit is exceeded', async () => {
    const fastify = createMockFastify();

    await rateLimiterPlugin(fastify, {
      store: { type: 'memory' },
      points: 1,
      duration: 60,
    });

    const req = { ip: '10.0.0.2', headers: {} };

    await fastify.onRequestHook!(req, makeReply().reply);

    const { reply, headers } = makeReply();
    await fastify.onRequestHook!(req, reply);

    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith({ error: 'rate_limit_exceeded' });
    expect(headers['Retry-After']).toBeDefined();
    expect(headers['RateLimit-Remaining']).toBe(0);
  });
});
