# Vero Relayer Service

A lightweight Node.js service that listens for GitHub webhook events and relays qualifying pull request activity onto the Stellar blockchain. It is the on-chain settlement layer for the **Wave Contribution Program**, a sprint-based open-source incentive model where maintainers post scoped issues and contributors earn verifiable on-chain records for their merged work.

---

## How It Works

```
GitHub PR merged
      |
      v
POST /github-webhook
      |
      |-- action === "closed"? skip if false
      |-- pull_request.merged === true? skip if false
      `-- labels includes "wave-contribution"? skip if false
                |
                v
      enqueue BullMQ job in Redis
                |
                v
      event worker calls registerTaskOnChain(pr.number)
                |
                v
      Stellar transaction submitted
      (manageData: vero:pr:<number>)
```

When a contributor's PR is merged and carries the `wave-contribution` label, the relayer captures the PR number, persists an event job in Redis, and returns `202 Accepted`. A separate BullMQ worker drains the queue and writes a `manageData` operation to Stellar.

---

## Quick Start

**1. Install dependencies**
```bash
npm install
```

**2. Configure environment**
```bash
cp .env.example .env
# Fill in STELLAR_SECRET_KEY and REDIS_PASSWORD
```

**3. Start Redis with password protection**
```bash
docker run --rm -p 6379:6379 redis:7-alpine redis-server --requirepass change-me
```

**4. Start the server**
```bash
npm start
# Server listening on port 3000
```

**5. Start the worker**
```bash
npm run worker:events
# [worker] status=started queue=vero:event-processing concurrency=5
```

**6. Simulate a webhook (no GitHub needed)**
```bash
npm run simulate
# [mock] Response: { ok: true, pr: 42, queued: true, jobId: "..." }
```

---

## Webhook Payload Contract

The service expects the standard GitHub `pull_request` event shape:

```json
{
  "action": "closed",
  "pull_request": {
    "number": 42,
    "merged": true,
    "labels": [
      { "name": "wave-contribution" }
    ]
  }
}
```

Any payload where `action` is not `closed`, `merged` is not `true`, or the label is absent is silently skipped with `{ "skipped": true }`.

Qualifying events return `202 Accepted` with `{ "ok": true, "pr": <number>, "queued": true, "jobId": "..." }` after the job is persisted to Redis.

---

## Health Check

`GET /health` is intended for orchestrator readiness probes. It runs bounded async checks for the Redis event queue, Stellar RPC, and local disk access. A healthy service returns `200` with `"status": "healthy"`; any failed, thrown, or timed-out check returns `503` with `"status": "degraded"`.

The response includes only sanitized check names, statuses, and latency values. It does not include connection strings, credentials, host paths, or raw error messages.

---

## The Wave Program

The Wave Program works by having maintainers create scoped issues that contributors pick up during sprint cycles. Each sprint has a fixed window, typically two weeks, and a defined set of issues tagged `wave-contribution`. When a contributor's PR for one of those issues is merged, this service queues the event and records the contribution on-chain through the worker.

### Types of work posted each sprint

| Category | Description |
|---|---|
| **Bug fixes** | Reproducible defects with a clear acceptance criterion, such as a failing test that must pass or a described broken behavior that must be resolved. |
| **New features** | Bounded feature additions scoped to a single module. Maintainers write the interface contract; contributors implement it. |
| **Documentation** | Missing or outdated docs, inline code comments, architecture diagrams, and usage examples. |
| **Testing** | New unit or integration tests for uncovered paths, edge cases, or regression scenarios. |
| **Refactors** | Isolated clean-up tasks with no behavior change. |

Maintainers label qualifying issues `wave-contribution` before the sprint opens. Contributors fork, implement, and open a PR against `main`. On merge, this service fires automatically.

---

## Project Structure

```
vero-relayer-service/
├── index.js                    # Express server + webhook route
├── stellar.js                  # Blockchain registration utility
├── src/
│   ├── queue/                  # Redis/BullMQ queue configuration
│   └── workers/                # Event queue worker
├── scripts/
│   └── mock-webhook.js         # Local simulation script
├── .env.example                # Required environment variables
└── package.json
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `LOG_LEVEL` | No | Pino log level, defaults to `info` |
| `LOG_REDACT_REMOVE` | No | Set to `true` to remove redacted fields instead of replacing with `[Redacted]` |
| `ENABLE_HTTP_REQUEST_LOGS` | No | Set to `false` to disable automatic request completion logs |
| `STELLAR_SECRET_KEY` | Yes | Signing key for the relayer account |
| `STELLAR_NETWORK` | No | `testnet` (default) or `mainnet` |
| `REDIS_HOST` | Yes | Redis host for BullMQ |
| `REDIS_PORT` | Yes | Redis port for BullMQ |
| `REDIS_USERNAME` | No | Redis ACL username, when required by the provider |
| `REDIS_PASSWORD` | Production | Redis password; required when `NODE_ENV=production` |
| `REDIS_TLS` | No | Set to `true` to enable TLS |
| `EVENT_QUEUE_NAME` | No | Defaults to `vero:event-processing` |
| `EVENT_QUEUE_CONCURRENCY` | No | Worker concurrency, defaults to `5` |
| `HEALTH_CHECK_TIMEOUT_MS` | No | Maximum time for `/health` checks before returning degraded, defaults to `1500` |
| `OTEL_SERVICE_NAME` | No | Service name reported to the tracing backend |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | No | OTLP endpoint for exporting traces, such as Jaeger or Grafana |
| `OTEL_SDK_DISABLED` | No | Set to `true` to disable tracing at startup |

---

## Logging

All runtime logs are structured JSON emitted by a single global [Pino](https://getpino.io)
instance (`src/logger.js`), so they are queryable by any log viewer. Sensitive fields
(`password`, `authorization`, `privateKey`, `STELLAR_SECRET_KEY`, ...) are redacted by
path before output.

On-chain transaction activity goes through a dedicated secure transaction logger
(`src/services/transaction-logger.js`). It binds every line to `component: "transaction"`
and a stable `txEvent` (`started`, `submitting`, `confirmed`, `retrying`, `failed`) plus a
consistent schema (`githubId`, `account`, `txHash`, `network`, `fee`), making the full
transaction lifecycle trivial to filter and trace. On top of the path-based redaction it
adds **value-level** scrubbing that the path redactor cannot do:

- Stellar secret seeds (`S...`) are replaced with `[Redacted]` anywhere they appear —
  including inside free-text error messages — so a leaked seed can never reach the stream.
- Stellar account ids (`G...`) are masked to a `GABCDE…234567` prefix/suffix form, keeping
  logs correlatable per-account without exposing the full identifier.

```jsonc
{"level":"info","component":"transaction","txEvent":"confirmed","githubId":42,"txHash":"...","message":"..."}
```

---

## Scripts

| Command | Description |
|---|---|
| `npm start` | Start the production server |
| `npm run dev` | Start with nodemon (auto-reload) |
| `npm run worker:events` | Start the BullMQ event worker |
| `npm run simulate` | Fire a mock webhook at localhost:3000 |
| `COUNT=125 npm run simulate` | Inject 125 mock webhooks |
| `npm test` | Run native Node.js tests |

---

## Manual Queue Verification

1. Start Redis with password protection:
   ```bash
   docker run --rm -p 6379:6379 redis:7-alpine redis-server --requirepass change-me
   ```
2. Set `.env` with `REDIS_HOST=127.0.0.1`, `REDIS_PORT=6379`, and the same `REDIS_PASSWORD`.
3. Start the app with `npm start`.
4. In a second terminal, start the worker with `npm run worker:events`.
5. Inject a burst of events with `COUNT=125 npm run simulate`.
6. Confirm jobs enter Redis:
   ```bash
   docker exec -it <redis-container> redis-cli -a change-me LLEN bull:vero:event-processing:wait
   ```
7. Watch the worker logs for `status=started`, `status=completed`, and retry `status=failed` entries. Logs include job ID, event type, and attempt number, but do not include Redis passwords or request headers.
8. Stop the worker during a burst and restart it to confirm persisted jobs continue draining from Redis.

---

## Automated Queue Cleanup

To prevent unbounded queue growth, the worker schedules a [node-cron](https://www.npmjs.com/package/node-cron)
job (`src/queue/cleanup.js`) that runs daily at midnight UTC and purges stale jobs
from Redis in bounded batches (at most `1000` jobs per state per run, via BullMQ's
`queue.clean`):

| Job state | Default grace | Rationale |
|---|---|---|
| `completed` | 1 day | Main driver of unbounded growth — BullMQ retains completed jobs indefinitely by default |
| `failed` | 7 days | Kept longer for inspection, then purged |

Each run emits audited log lines per state (`queue cleanup started` / `completed`) plus
a `queue cleanup summary` with the removed counts (`{ completed, failed, total }`). A
failed cleanup run is logged and swallowed so it never crashes the worker. Grace periods,
batch limit, schedule, and the set of purged states are all overridable via
`createCleanupJob` options.

---

## M-of-N Multi-Signature Admin Architecture

The `contracts/vero-admin` Soroban contract replaces the previous single-key admin model with a threshold-based multisig scheme, eliminating the "God-key" vulnerability.

### How it works

```
Admin A  ──propose_register_task(pr=42)──► proposal stored (1/M approvals)
Admin B  ──approve(action_hash)──────────► 2/M approvals → threshold reached → executed
Admin C  ──approve(action_hash)──────────► AlreadyExecuted ✗
Rogue    ──propose_register_task(pr=1)───► Unauthorized ✗
```

### Configuration

| Parameter   | Storage key   | Description                                               |
|-------------|---------------|-----------------------------------------------------------|
| `admins`    | `DataKey::Admins`    | Ordered `Vec<Address>` of N authorised signers    |
| `threshold` | `DataKey::Threshold` | M — minimum approvals needed to execute an action |
| `nonce`     | `DataKey::Nonce`     | Auto-incremented after each execution             |

### Initialisation

```bash
# Deploy and initialise with 3 admins, requiring 2 approvals (2-of-3)
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source admin_a \
  -- initialize \
  --admins '[<ADDR_A>, <ADDR_B>, <ADDR_C>]' \
  --threshold 2
```

### Admin workflow

```bash
# 1. Any admin proposes an action (auto-counts as 1 approval)
HASH=$(soroban contract invoke \
  --id <CONTRACT_ID> --source admin_a \
  -- propose_register_task --proposer <ADDR_A> --pr 42)

# 2. A second admin approves — threshold met → executes
soroban contract invoke \
  --id <CONTRACT_ID> --source admin_b \
  -- approve --approver <ADDR_B> --action_hash "$HASH"
```

### Replay prevention

Every proposal hash is derived as:

```
sha256( nonce_le_bytes || action_tag || action_payload )
```

The `nonce` increments atomically on each successful execution. Any previously broadcast-but-rejected signature payload yields a hash that maps to no live proposal, making replay attacks impossible.

### Accepted action types

| Variant              | Description                                  |
|----------------------|----------------------------------------------|
| `RegisterTask(pr)`   | Record a merged PR number on-chain           |
| `PurgeTask(pr)`      | Remove a previously registered PR            |
| `UpdateThreshold(m)` | Change the approval quorum                   |
| `UpdateAdmins(list)` | Replace the entire admin registry atomically |

### Contract layout

```
contracts/vero-admin/
├── Cargo.toml
└── src/
    ├── lib.rs      # #[contract] entry points + unit tests
    ├── admin.rs    # multisig core logic
    ├── types.rs    # MultisigAction, AdminAction, DataKey
    └── errors.rs   # AdminError codes
```

### Running contract tests

```bash
cd contracts/vero-admin
cargo test
```
