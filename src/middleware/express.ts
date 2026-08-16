import type { RateLimiterOptions } from '../config/schema.js';
import { RateLimiterUnavailableError } from '../errors/rate-limit-exceeded.error.js';
import { createLimiterBundle } from './shared/create-limiter.js';
import type { MinimalRequest } from './shared/key-generator.js';
import {
  applyRateLimitHeaders,
  applyRetryAfterHeader,
  type RateLimitHeaderSink,
} from './shared/response-header.js';

/**
 * Duck-typed Express request — keeps this package free of an `@types/express`
 * hard dependency while remaining structurally compatible with real requests.
 */
export interface ExpressRequest extends MinimalRequest {
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface ExpressResponse extends RateLimitHeaderSink {
  status(code: number): ExpressResponse;
  json(body: unknown): ExpressResponse | void;
}

export type ExpressNextFunction = (error?: unknown) => void;

export type ExpressRateLimitMiddleware = (
  req: ExpressRequest,
  res: ExpressResponse,
  next: ExpressNextFunction,
) => void | Promise<void>;

/**
 * Creates Express middleware that evaluates and records one request per call.
 * Register with `app.use(limiter)` or on specific routes.
 */
export function createExpressRateLimiter(options: RateLimiterOptions): ExpressRateLimitMiddleware {
  const { config, limiter } = createLimiterBundle(options);

  return async function expressRateLimitMiddleware(
    req: ExpressRequest,
    res: ExpressResponse,
    next: ExpressNextFunction,
  ): Promise<void> {
    try {
      if (config.skip?.(req)) {
        next();
        return;
      }

      const key = config.keyGenerator(req);
      const result = await limiter.checkLimit(key);

      if (config.headers) {
        applyRateLimitHeaders(res, result);
        if (!result.allowed) {
          applyRetryAfterHeader(res, result);
        }
      }

      if (!result.allowed) {
        if (config.onLimitExceeded !== undefined) {
          config.onLimitExceeded(req, res, result);
          return;
        }

        res.status(429).json({ error: 'rate_limit_exceeded' });
        return;
      }

      next();
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) {
        res.status(503).json({ error: 'rate_limiter_unavailable' });
        return;
      }

      next(error);
    }
  };
}
