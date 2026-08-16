import { describe, it, expect, vi } from 'vitest';
import { createExpressRateLimiter } from '../src/middleware/express.js';
import type { RateLimitHeaderSink } from '../src/middleware/shared/response-header.js';
import {
  applyRateLimitHeaders,
  applyRetryAfterHeader,
} from '../src/middleware/shared/response-header.js';
import { buildRateLimitResult } from '../src/core/result.js';

describe('response-header', () => {
  it('sets RateLimit-* headers', () => {
    const headers: Record<string, string | number> = {};
    const sink: RateLimitHeaderSink = {
      setHeader: (name, value) => {
        headers[name] = value;
      },
    };

    applyRateLimitHeaders(sink, buildRateLimitResult({ limit: 100, totalHits: 10, resetMs: 37_000 }));

    expect(headers).toEqual({
      'RateLimit-Limit': 100,
      'RateLimit-Remaining': 90,
      'RateLimit-Reset': 37,
    });
  });

  it('sets Retry-After in seconds', () => {
    const headers: Record<string, string | number> = {};
    const sink: RateLimitHeaderSink = {
      setHeader: (name, value) => {
        headers[name] = value;
      },
    };

    applyRetryAfterHeader(sink, buildRateLimitResult({ limit: 1, totalHits: 2, resetMs: 500 }));

    expect(headers['Retry-After']).toBe(1);
  });
});

describe('createExpressRateLimiter', () => {
  it('allows requests under the limit and sets headers', async () => {
    const middleware = createExpressRateLimiter({
      store: { type: 'memory' },
      points: 2,
      duration: 60,
    });

    const headers: Record<string, string | number> = {};
    const req = { ip: '127.0.0.1', headers: {} };
    const res = {
      setHeader: (name: string, value: string | number) => {
        headers[name] = value;
      },
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(headers['RateLimit-Limit']).toBe(2);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 429 when over limit', async () => {
    const middleware = createExpressRateLimiter({
      store: { type: 'memory' },
      points: 1,
      duration: 60,
    });

    const req = { ip: '10.0.0.1', headers: {} };
    const makeRes = () => ({
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });

    const firstRes = makeRes();
    await middleware(req, firstRes, vi.fn());
    const secondRes = makeRes();
    const next = vi.fn();

    await middleware(req, secondRes, next);

    expect(next).not.toHaveBeenCalled();
    expect(secondRes.status).toHaveBeenCalledWith(429);
    expect(secondRes.json).toHaveBeenCalledWith({ error: 'rate_limit_exceeded' });
    expect(secondRes.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });
});
