
# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added
- feat: IP-based request rate limiting for public ingress and authenticated routes. Implemented `ingestRateLimiter` using `express-rate-limit` with optional Redis-backed store, Prometheus metric `rate_limit_hits_total`, and structured logging. Configurable via `RATE_LIMIT_*` environment variables. (closes #71)
- feat: Enhanced PostgreSQL connection pooling with persistent connections and comprehensive monitoring. Implemented singleton pg-pool in `src/db/client.{js,ts}` with configurable min/max connections, connection lifecycle event logging, health check endpoint integration, and pool metrics exposure via `/health`. Added benchmark suite (`benchmarks/pool-performance.js`) to verify connection reuse efficiency, concurrent burst handling, and pool saturation behavior. Includes detailed documentation in `docs/database-pooling.md`. Environment configuration via `DATABASE_URL`, `DB_POOL_MIN`, `DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT`, and `DB_POOL_CONNECTION_TIMEOUT`.

### Fixed
- Prevented the sequential-nonce advisory lock from reusing cached Stellar account sequences during concurrent broadcasts.
- Defensive guards for Prometheus metric registration and logger fallbacks to improve test stability.
