## Summary
closes #54
- Add distributed tracing support for inbound requests and outbound service calls
- Propagate trace headers so downstream RPC and alert calls stay correlated
- Make tracing configuration configurable via environment variables

## Changes
- Initialized OpenTelemetry tracing during server startup
- Added request span creation for HTTP handlers
- Injected trace headers into outbound RPC and alert requests
- Added regression tests for trace header propagation
- Documented tracing configuration in the environment template and README

## Verification
- `npm test`

## Notes
- This PR is intended to make request latency and cross-service flow visible in Jaeger/Grafana while keeping existing webhook behavior unchanged.
