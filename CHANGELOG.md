# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added
- feat: IP-based request rate limiting for public ingress and authenticated routes. Implemented `ingestRateLimiter` using `express-rate-limit` with optional Redis-backed store, Prometheus metric `rate_limit_hits_total`, and structured logging. Configurable via `RATE_LIMIT_*` environment variables. (closes #71)

### Fixed
- Defensive guards for Prometheus metric registration and logger fallbacks to improve test stability.

