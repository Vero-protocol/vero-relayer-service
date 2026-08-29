# Security Policy

## Supported Versions

This project ships from `main` on a rolling basis — there are no maintained release branches. Security fixes are applied to `main` and should be picked up by redeploying from the latest commit.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately via [GitHub Private Vulnerability Reporting](https://github.com/Vero-protocol/vero-relayer-service/security/advisories/new) (Security tab → "Report a vulnerability"). This opens a private advisory visible only to maintainers until a fix is ready.

If that's unavailable, open a [private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) or contact a maintainer directly through GitHub.

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal PoC is very helpful)
- Any relevant logs, request payloads, or configuration

### What to expect

- Acknowledgement within a few days
- An assessment of severity and affected areas
- A fix, coordinated disclosure timeline, and credit (if desired) once resolved

## Scope of Particular Interest

This service holds a Stellar signing key and bridges GitHub webhook events to on-chain transactions. Reports involving the following are especially high priority:

- Webhook signature verification (`src/middleware/auth.js`) — bypasses or forgery
- JWT service-to-service auth (`src/services/jwt.js`, `src/middleware/jwt-auth.js`) — signature/claim validation bypasses
- Dynamic config sync (`src/services/config-poller.js`, `src/services/config-worker.js`) — unauthenticated or unsigned config being applied to a running process
- Anything that could exfiltrate `STELLAR_SECRET_KEY`, `DATABASE_URL`, `JWT_SIGNING_SECRET`, or other values from `.env`
- Idempotency/replay handling (`src/middleware/idempotency.js`, `src/queue/raw-event-store.js`) — double-submission or replay of on-chain transactions

## Automated Scanning

This repository runs [CodeQL](.github/workflows/codeql.yml) on every push/PR and weekly on a schedule, and [Dependabot](.github/dependabot.yml) for dependency updates. CI additionally runs `npm audit` on every PR and fails on high/critical advisories.
