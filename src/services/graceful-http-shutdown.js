'use strict';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 10 * 60_000;

function getShutdownTimeoutMs(raw = process.env.SHUTDOWN_TIMEOUT_MS) {
  if (raw === undefined || raw === '') return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const timeout = Number(raw);
  return Number.isSafeInteger(timeout) && timeout > 0 && timeout <= MAX_SHUTDOWN_TIMEOUT_MS
    ? timeout
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

/**
 * Stop accepting new HTTP connections, then wait for already-active requests
 * to finish. If the configured deadline expires, forcibly close the remaining
 * HTTP sockets and report a failure rather than declaring a clean shutdown.
 */
function closeHttpServer(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let idleSweep;

    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(idleSweep);
      if (error) reject(error);
      else resolve();
    };

    timer = setTimeout(() => {
      // A forced close is never a successful graceful drain.
      const timeoutError = new Error('HTTP server did not drain within ' + timeoutMs + ' ms');
      try {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      } catch (error) {
        timeoutError.cause = error;
      }
      finish(timeoutError);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      server.close(error => finish(error));
      // Node 22+ automatically handles idle keep-alive connections; explicitly
      // closing them remains useful for HTTP versions that expose this method.
      if (!settled && typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
        // After an active request finishes it can become an idle keepalive
        // socket. Only sweep *idle* connections while the drain is pending.
        idleSweep = setInterval(() => {
          try {
            server.closeIdleConnections();
          } catch (error) {
            finish(error);
          }
        }, 50);
        if (typeof idleSweep.unref === 'function') idleSweep.unref();
      }
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Centralize teardown under the entrypoint that owns the HTTP listener.
 * Importing the PostgreSQL module must NOT install competing process.exit()
 * signal handlers, because those can preempt this server drain.
 *
 * @param {object} options
 * @param {import('node:http').Server} options.server
 * @param {() => void} options.stopPoller
 * @param {Array<{name: string, close: () => Promise<void>|void}>} options.closeResources
 * @param {object} options.log
 * @param {number} options.timeoutMs
 */
function createGracefulShutdown({ server, stopPoller, closeResources = [], log, timeoutMs = getShutdownTimeoutMs() }) {
  if (!server || typeof server.close !== 'function') {
    throw new TypeError('A running HTTP server is required');
  }
  if (!log || typeof log.info !== 'function' || typeof log.error !== 'function') {
    throw new TypeError('A structured logger is required');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive integer');
  }

  let currentShutdown = null;

  function shutdown(signal) {
    if (currentShutdown) return currentShutdown;

    currentShutdown = (async () => {
      const startedAt = Date.now();
      const failures = [];
      log.info({ signal, timeoutMs }, '[shutdown] HTTP server shutdown started');

      // Stop accepting new HTTP requests *synchronously*, before awaiting
      // any asynchronous poller teardown. Attach an error handler immediately
      // so a quick failed close cannot produce an unhandled rejection.
      const draining = closeHttpServer(server, timeoutMs).then(
        () => null,
        error => error
      );

      // Existing HTTP requests may still run while the poller is stopping.
      try {
        if (stopPoller) await stopPoller();
      } catch (error) {
        failures.push(error);
        log.error({ error: error.message }, '[shutdown] Config poller shutdown failed');
      }

      const drainError = await draining;
      if (drainError) {
        failures.push(drainError);
        log.error({ error: drainError.message }, '[shutdown] HTTP server drain failed');
      } else {
        log.info('[shutdown] Active HTTP requests drained');
      }

      // Every closer gets a chance, even if another fails. A shared remaining
      // deadline bounds cleanup if a Redis or database close hangs.
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      let timer;
      try {
        const closing = Promise.allSettled(closeResources.map(({ name, close }) =>
          Promise.resolve().then(close).catch(error => {
            log.error({ name, error: error.message }, '[shutdown] Resource close failed');
            throw error;
          })
        ));

        const completed = await Promise.race([
          closing,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Resource cleanup did not finish within shutdown deadline')),
              remainingMs
            );
          })
        ]);

        for (const result of completed) {
          if (result.status === 'rejected') failures.push(result.reason);
        }
      } catch (error) {
        failures.push(error);
        log.error({ error: error.message }, '[shutdown] Resource cleanup timed out');
      } finally {
        clearTimeout(timer);
      }

      if (failures.length > 0) {
        throw new AggregateError(failures, 'Graceful HTTP shutdown was incomplete');
      }

      log.info({ signal }, '[shutdown] All HTTP requests and resources closed');
    })();

    return currentShutdown;
  }

  /**
   * Install exactly one coordinated SIGTERM/SIGINT path. The caller owns exit;
   * tests can inject an EventEmitter and exit callback without emitting real
   * operating-system signals or terminating their process.
   */
  function installSignals({ emitter = process, exit = code => process.exit(code) } = {}) {
    let handled = false;

    const onSignal = signal => {
      if (handled) return;
      handled = true;
      emitter.removeListener('SIGTERM', onTerm);
      emitter.removeListener('SIGINT', onInt);

      shutdown(signal).then(
        () => exit(0),
        error => {
          log.error({ signal, error: error.message }, '[shutdown] Exiting after incomplete shutdown');
          exit(1);
        }
      );
    };

    const onTerm = () => onSignal('SIGTERM');
    const onInt = () => onSignal('SIGINT');
    emitter.on('SIGTERM', onTerm);
    emitter.on('SIGINT', onInt);

    return () => {
      emitter.removeListener('SIGTERM', onTerm);
      emitter.removeListener('SIGINT', onInt);
    };
  }

  return { shutdown, installSignals };
}

module.exports = { createGracefulShutdown, closeHttpServer, getShutdownTimeoutMs };
