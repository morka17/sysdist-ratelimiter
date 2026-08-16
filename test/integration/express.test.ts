import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { createExpressRateLimiter } from '../../src/middleware/express.js';

function buildApp(): Express {
  const app = express();
  app.use(
    createExpressRateLimiter({
      store: { type: 'memory' },
      points: 3,
      duration: 60,
      keyGenerator: (req) => (req.headers['x-api-key'] as string | undefined) ?? req.ip ?? 'unknown',
    }),
  );
  app.get('/', (_req, res) => res.json({ message: 'ok' }));
  return app;
}

describe('Express integration', () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
  });

  it('allows requests under the limit and sets RateLimit-* headers', async () => {
    const res = await request(app).get('/').set('x-api-key', 'client-a');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'ok' });
    expect(res.headers['ratelimit-limit']).toBe('3');
    expect(res.headers['ratelimit-remaining']).toBe('2');
  });

  it('rejects with 429 and Retry-After once the limit is exceeded', async () => {
    const agent = request(app);

    await agent.get('/').set('x-api-key', 'client-b');
    await agent.get('/').set('x-api-key', 'client-b');
    await agent.get('/').set('x-api-key', 'client-b');
    const blocked = await agent.get('/').set('x-api-key', 'client-b');

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'rate_limit_exceeded' });
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
  });

  it('enforces limits independently per key', async () => {
    const agent = request(app);

    await agent.get('/').set('x-api-key', 'client-c');
    await agent.get('/').set('x-api-key', 'client-c');
    await agent.get('/').set('x-api-key', 'client-c');
    const cBlocked = await agent.get('/').set('x-api-key', 'client-c');
    expect(cBlocked.status).toBe(429);

    const dRes = await agent.get('/').set('x-api-key', 'client-d');
    expect(dRes.status).toBe(200);
    expect(dRes.headers['ratelimit-remaining']).toBe('2');
  });

  it('RateLimit-Remaining decreases monotonically across sequential requests for one key', async () => {
    const agent = request(app);

    const first = await agent.get('/').set('x-api-key', 'client-e');
    const second = await agent.get('/').set('x-api-key', 'client-e');
    const third = await agent.get('/').set('x-api-key', 'client-e');

    expect(first.headers['ratelimit-remaining']).toBe('2');
    expect(second.headers['ratelimit-remaining']).toBe('1');
    expect(third.headers['ratelimit-remaining']).toBe('0');
  });
});
