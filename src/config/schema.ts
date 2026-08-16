import { z } from 'zod';
import type { KeyGenerator } from '../middleware/shared/key-generator.js';

// Re-exported so callers can `import type { KeyGenerator } from './schema.js'`
// without reaching into middleware/ directly.
export type { KeyGenerator };

/**
 * Raw, user-facing options. Everything except `store` is optional —
 * `config/defaults.ts` fills the rest via `DEFAULT_OPTIONS`.
 */
export interface RateLimiterOptions {
  store: {
    client?: unknown;
    type?: 'redis' | 'memory';
    keyPrefix?: string;
  };
  algorithm?: 'sliding-window' | 'token-bucket';
  points?: number;
  duration?: number;
  /** Required when algorithm === 'token-bucket'. Tokens added per second. */
  refillRate?: number;
  /** Required when algorithm === 'token-bucket'. Max token capacity. */
  bucketSize?: number;
  keyGenerator?: KeyGenerator;
  failMode?: 'open' | 'closed';
  skip?: (req: unknown) => boolean;
  headers?: boolean;
  onLimitExceeded?: (req: unknown, res: unknown, info: unknown) => void;
  metrics?: { enabled?: boolean; registry?: unknown };
  logger?: unknown;
}

/**
 * Fully populated config every internal consumer (`core/limiter.ts`,
 * algorithms, stores) depends on. Produced exclusively by
 * `config/defaults.ts#resolveConfig` — no other file should construct one
 * directly, so there is exactly one place default values live.
 *
 * NOTE: `store` is declared explicitly (not derived via `Required<>`)
 * because `Required<T>` is shallow — it would make the `store` property
 * itself non-optional but leave `store.keyPrefix` as `string | undefined`,
 * which is exactly the field every consumer needs guaranteed-present.
 */
export type ResolvedRateLimiterConfig = Required<
  Omit<RateLimiterOptions, 'skip' | 'onLimitExceeded' | 'logger' | 'refillRate' | 'bucketSize' | 'store'>
> &
  Pick<RateLimiterOptions, 'skip' | 'onLimitExceeded' | 'logger' | 'refillRate' | 'bucketSize'> & {
    store: {
      client?: unknown;
      type: 'redis' | 'memory';
      keyPrefix: string;
    };
  };

/**
 * Validates raw options before defaults are known to be safe to apply.
 * Deliberately permissive on function-typed fields (`z.function()` is
 * avoided) since zod's function validation adds runtime call overhead we
 * don't want on every request; shape/type correctness for those is
 * enforced by TypeScript at the call site instead.
 */
export const rateLimiterOptionsSchema: z.ZodType<RateLimiterOptions> = z
  .object({
    store: z.object({
      client: z.unknown().optional(),
      type: z.enum(['redis', 'memory']).optional(),
      keyPrefix: z.string().min(1).optional(),
    }),
    algorithm: z.enum(['sliding-window', 'token-bucket']).optional(),
    points: z.number().positive().optional(),
    duration: z.number().positive().optional(),
    refillRate: z.number().positive().optional(),
    bucketSize: z.number().positive().optional(),
    keyGenerator: z.custom<KeyGenerator>((val) => typeof val === 'function').optional(),
    failMode: z.enum(['open', 'closed']).optional(),
    skip: z.custom<(req: unknown) => boolean>((val) => typeof val === 'function').optional(),
    headers: z.boolean().optional(),
    onLimitExceeded: z
      .custom<(req: unknown, res: unknown, info: unknown) => void>((val) => typeof val === 'function')
      .optional(),
    metrics: z
      .object({
        enabled: z.boolean().optional(),
        registry: z.unknown().optional(),
      })
      .optional(),
    logger: z.unknown().optional(),
  })
  .superRefine((options, ctx) => {
    if (options.algorithm === 'token-bucket') {
      if (options.refillRate === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['refillRate'],
          message: "refillRate is required when algorithm is 'token-bucket'",
        });
      }
      if (options.bucketSize === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bucketSize'],
          message: "bucketSize is required when algorithm is 'token-bucket'",
        });
      }
    }
  }) as unknown as z.ZodType<RateLimiterOptions>;