# Express basic example

Minimal Express app using `createExpressRateLimiter` from this repo.

## Run

From the repo root:

```bash
cd examples/express-basic
npm install
npm start
```

Uses an in-memory store by default (single process only). To use Redis, set in the repo-root `.env`:

```env
USER_REDIS=true
REDIS_URL=redis://localhost:6379
```

Optional:

```env
PORT=3000
RATE_LIMIT_POINTS=100
RATE_LIMIT_DURATION=60
```

## Try it

```bash
curl -i http://localhost:3000/ -H "x-api-key: demo"
```

Watch `RateLimit-*` headers on each response. Exceed the limit to receive `429` with `Retry-After`.
