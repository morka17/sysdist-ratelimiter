import express from 'express';
import { createExpressRateLimiter } from '../../../src/middleware/express.js';
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

const app = express();
app.set('trust proxy', true);
app.use(createExpressRateLimiter(limiterOptions));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (_req, res) => {
  res.json({
    message: 'ok',
    hint: 'Send x-api-key header to exercise per-key limits',
  });
});

const port = getPort();

app.listen(port, () => {
  console.log(`express-basic listening on http://localhost:${port}`);
  console.log(
    `store=${useRedis() ? 'redis' : 'memory'} limit=${limiterOptions.points}/${limiterOptions.duration}s`,
  );
});
