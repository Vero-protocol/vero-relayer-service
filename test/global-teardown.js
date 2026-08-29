'use strict';

const { after } = require('node:test');

// Several modules lazily open a real connection to a shared external service
// (Postgres pool, Redis clients, BullMQ queue) the first time they're used,
// and cache it as a module-level singleton. Against real, reachable services
// (as in CI, unlike local dev where connections just fail fast) an unclosed
// connection keeps that test file's subprocess alive indefinitely, hanging
// the whole suite — this has bitten webhook.test.js, event-worker.test.js,
// and stellar-fee.test.js so far, each via a different call path into the
// same handful of singletons. Rather than relying on every test file to
// remember its own teardown, close everything known to be lazily opened
// once, after each file's tests finish.
//
// Critically: only close a module that this test file's own code already
// loaded (require.resolve + require.cache check). Some of these modules
// (rateLimit.js in particular) open their own real connection as a side
// effect of merely being required, so blindly requiring them here "just to
// close them" would create a brand-new leak in every file that never
// touched them in the first place, instead of cleaning up an existing one.
const CLOSERS = [
  { modulePath: '../src/db/client', close: mod => mod.shutdown() },
  { modulePath: '../src/middleware/idempotency', close: mod => mod.closeRedisClient() },
  { modulePath: '../src/middleware/rateLimit', close: mod => mod.closeRedisClient() },
  { modulePath: '../src/queue/event-queue', close: mod => mod.closeEventQueue() },
  { modulePath: '../src/services/fee-engine', close: mod => mod.closeRpcCache() },
];

after(async () => {
  await Promise.all(CLOSERS.map(async ({ modulePath, close }) => {
    let resolved;
    try {
      resolved = require.resolve(modulePath);
    } catch {
      return;
    }
    if (!require.cache[resolved]) return;

    try {
      await close(require(modulePath));
    } catch {
      // best-effort cleanup
    }
  }));
});
