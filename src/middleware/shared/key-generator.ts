/**
 * Framework-agnostic minimal request shape — duck-typed so this file has
 * no dependency on Express/Fastify types. `middleware/express.ts` and
 * `middleware/fastify.ts` pass their real request objects, which satisfy
 * this shape structurally.
 */
export interface MinimalRequest {
    ip?: string;
    headers: Record<string, string | string[] | undefined>;
}

export type KeyGenerator = (req: MinimalRequest) => string;

/**
 * Default key derivation: prefer the first `X-Forwarded-For` entry (trust
 * of that header is assumed to be handled upstream by the framework's own
 * "trust proxy" setting), falling back to `req.ip`, then a constant
 * so misconfigured deployments degrade to a single shared bucket rather
 * than throwing.
 */
export const DEFAULT_KEY_GENERATOR: KeyGenerator = (req) => {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
        const parts = forwardedFor.split(',');
        const first = parts[0]?.trim();
        if (first) {
            return first;
        }
    } else if (Array.isArray(forwardedFor) && forwardedFor.length > 0 && forwardedFor[0]) {
        return forwardedFor[0];
    }
    return req.ip ?? 'unknown';
};