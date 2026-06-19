const { getDiagnosticReport } = require('../services/diagnostics');

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 1500;

function parseTimeoutMs(value) {
  const timeoutMs = Number(value || DEFAULT_HEALTH_CHECK_TIMEOUT_MS);

  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    return DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  }

  return timeoutMs;
}

function sanitizeCheck(check) {
  if (!check || typeof check !== 'object') {
    return {
      status: 'unknown',
      ok: false
    };
  }

  const sanitized = {
    status: check.status || (check.ok ? 'ok' : 'error'),
    ok: check.ok === true
  };

  if (Number.isFinite(check.latencyMs)) {
    sanitized.latencyMs = check.latencyMs;
  }

  return sanitized;
}

function sanitizeHealthReport(report) {
  const ok = report && report.summary && report.summary.ok === true;
  const checks = (report && report.checks) || {};

  return {
    status: ok ? 'healthy' : 'degraded',
    checkedAt: (report && report.summary && report.summary.checkedAt) || new Date().toISOString(),
    checks: {
      redis: sanitizeCheck(checks.db),
      rpc: sanitizeCheck(checks.rpc),
      disk: sanitizeCheck(checks.disk)
    }
  };
}

function withTimeout(promise, timeoutMs) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('health check timed out')), timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createHealthHandler(options = {}) {
  const getHealthReport = options.getHealthReport || getDiagnosticReport;
  const timeoutMs = parseTimeoutMs(options.timeoutMs || process.env.HEALTH_CHECK_TIMEOUT_MS);

  return async function healthHandler(req, res) {
    res.set('Cache-Control', 'no-store');

    try {
      const report = await withTimeout(Promise.resolve().then(() => getHealthReport()), timeoutMs);
      const body = sanitizeHealthReport(report);

      return res.status(body.status === 'healthy' ? 200 : 503).json(body);
    } catch (_) {
      return res.status(503).json({
        status: 'degraded',
        checkedAt: new Date().toISOString(),
        checks: {
          health: {
            status: 'error',
            ok: false
          }
        }
      });
    }
  };
}

module.exports = {
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  createHealthHandler,
  sanitizeHealthReport
};
