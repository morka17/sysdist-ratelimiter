import Fastify from 'fastify';
import rateLimiterPlugin from '../../../src/middleware/fastify.js';
import type { RateLimiterOptions } from '../../../src/config/schema.js';
import {
  getPort,
  getRateLimitDuration,
  getRateLimitPoints,
  loadDotEnv,
  useRedis,
} from '../../shared/env.js';
import { createRedisClient } from '../../shared/redis-client.js';

loadDotEnv();

const limiterOptions: RateLimiterOptions = {
  store: useRedis()
    ? { type: 'redis', client: createRedisClient() }
    : { type: 'memory' },
  algorithm: 'sliding-window',
  points: getRateLimitPoints(),
  duration: getRateLimitDuration(),
  keyGenerator: (req) =>
    (req.headers['x-api-key'] as string | undefined) ?? req.ip ?? 'unknown',
};

const app = Fastify();

await app.register(rateLimiterPlugin, limiterOptions);

app.get('/health', async () => ({ status: 'ok' }));

app.get('/', async () => ({
  message: 'ok',
  hint: 'Send x-api-key header to exercise per-key limits',
}));

const port = getPort();

app
  .listen({ port })
  .then(() => {
    console.log(`fastify-basic listening on http://localhost:${port}`);
    console.log(
      `store=${useRedis() ? 'redis' : 'memory'} limit=${limiterOptions.points}/${limiterOptions.duration}s`,
    );
  })
  .catch((error: any) => {
    console.error('Failed to start example server:', error);
    process.exit(1);
  });