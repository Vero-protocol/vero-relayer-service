feat: add IP-based request rate limiting (#71)

Adds IP-based request rate limiting to protect public ingress from DDoS and high request volume.

What changed
- `src/middleware/rateLimit.js`: implements `ingestRateLimiter` using `express-rate-limit` with two policies (public / authenticated), X-Forwarded-For aware via `trust proxy`, optional Redis-backed store (uses `ioredis` when `REDIS_HOST` is set), Prometheus metric increment on hits, structured logging on 429, and defensive fallbacks for tests.
- `src/metrics/metrics.js`: adds Prometheus counter `rate_limit_hits_total` and makes registration idempotent to avoid duplicate registration in test runs.
- `test/rateLimit.test.js`: adds tests to verify X-Forwarded-For grouping and triggering 429 by tightening `RATE_LIMIT_PUBLIC_MAX`.
- `.env.example`: documents `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_PUBLIC_MAX`, `RATE_LIMIT_AUTH_MAX`.
- `CHANGELOG.md`: Unreleased entry describing the feature.

Implementation notes
- Public limiter default: 100 requests / 15 minutes per IP (configurable via `RATE_LIMIT_PUBLIC_MAX` and `RATE_LIMIT_WINDOW_MS`).
- Authenticated limiter default: 1,000 requests / 15 minutes per IP (configurable via `RATE_LIMIT_AUTH_MAX`).
- Optional Redis store: enabled when `REDIS_HOST` is set; falls back to in-memory store otherwise.
- Responses on limit violation: HTTP 429 with JSON body `{ error, code: "RATE_LIMIT_EXCEEDED", retryAfter }` and RFC RateLimit-* headers when provided by `express-rate-limit`.

Configuration
- Env vars introduced / supported:
  - `RATE_LIMIT_WINDOW_MS` (ms, default 900000)
  - `RATE_LIMIT_PUBLIC_MAX` (default 100)
  - `RATE_LIMIT_AUTH_MAX` (default 1000)
- Existing Redis env vars remain unchanged: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, etc.

Testing & verification
- Unit tests:
  ```bash
  npx jest --runInBand --testTimeout=30000
  ```
- Manual verification (tight limits):
  ```bash
  RATE_LIMIT_PUBLIC_MAX=1 node index.js
  # send 2 requests from same IP -> 2nd returns 429 with JSON { code: 'RATE_LIMIT_EXCEEDED' }
  ```

Compatibility & notes
- Metric registration guarded to avoid duplicate registration in environments that reload modules during tests.
- Fallbacks provided so tests run without external deps (no Redis required).
- No database or schema changes.

Security & audit
- Rate limiting is IP-based and relies on Express `trust proxy` to use `X-Forwarded-For` when behind a proxy. Ensure `app.set('trust proxy', ...)` is configured correctly for your deployment.

Closes #71
