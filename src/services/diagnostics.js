const fs = require('fs/promises');
const os = require('os');
const { getEventQueue } = require('../queue/event-queue');
const { logger } = require('../logger');
const { injectTraceHeaders } = require('../tracing');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return String(value).toLowerCase() === 'true';
}

function getAlertChannels(env = process.env) {
  const channels = [];

  if (env.SLACK_WEBHOOK_URL || env.ALERT_SLACK_WEBHOOK_URL) {
    channels.push('slack');
  }

  if (env.ALERT_EMAIL_TO || env.HEARTBEAT_EMAIL_TO) {
    channels.push('email');
  }

  return channels;
}

async function checkRedisConnection() {
  const startedAt = Date.now();

  try {
    const queue = getEventQueue();
    await queue.isReady();
    return {
      status: 'ok',
      ok: true,
      latencyMs: Date.now() - startedAt,
      details: 'Redis queue connection is ready'
    };
  } catch (error) {
    return {
      status: 'error',
      ok: false,
      latencyMs: Date.now() - startedAt,
      details: error.message
    };
  }
}

async function checkRpcConnection(env = process.env) {
  const startedAt = Date.now();
  const rpcUrl = env.STELLAR_RPC_URL || env.RPC_URL;

  if (!rpcUrl) {
    return {
      status: 'not_configured',
      ok: false,
      latencyMs: 0,
      details: 'STELLAR_RPC_URL is not set'
    };
  }

  try {
    const response = await fetch(rpcUrl, {
      method: 'GET',
      headers: injectTraceHeaders({
        accept: 'application/json'
      })
    });

    return {
      status: response.ok ? 'ok' : 'error',
      ok: response.ok,
      latencyMs: Date.now() - startedAt,
      details: `RPC responded with ${response.status}`
    };
  } catch (error) {
    return {
      status: 'error',
      ok: false,
      latencyMs: Date.now() - startedAt,
      details: error.message
    };
  }
}

async function checkDiskAccess(targetPath = process.cwd()) {
  try {
    await fs.access(targetPath, fs.constants.R_OK | fs.constants.W_OK);
    const stats = await fs.stat(targetPath);
    return {
      status: 'ok',
      ok: true,
      path: targetPath,
      size: stats.size,
      details: 'Working directory is readable and writable'
    };
  } catch (error) {
    return {
      status: 'error',
      ok: false,
      path: targetPath,
      details: error.message
    };
  }
}

async function getDiagnosticReport(options = {}) {
  const env = options.env || process.env;
  const [db, rpc, disk] = await Promise.all([
    Promise.resolve((options.checkDb || checkRedisConnection)(env)),
    Promise.resolve((options.checkRpc || checkRpcConnection)(env)),
    Promise.resolve((options.checkDisk || (() => checkDiskAccess()))())
  ]);

  const report = {
    summary: {
      ok: db.ok && rpc.ok && disk.ok,
      checkedAt: new Date().toISOString(),
      hostname: os.hostname(),
      platform: os.platform()
    },
    checks: {
      db,
      rpc,
      disk
    },
    alerts: {
      enabled: getAlertChannels(env).length > 0,
      channels: getAlertChannels(env)
    }
  };

  return report;
}

async function sendDiagnosticAlert(report, options = {}) {
  const env = options.env || process.env;
  const channels = getAlertChannels(env);
  const message = [
    'Vero relayer diagnostic report',
    `Status: ${report.summary.ok ? 'OK' : 'FAIL'}`,
    `Checked at: ${report.summary.checkedAt}`,
    `DB: ${report.checks.db.status}`,
    `RPC: ${report.checks.rpc.status}`,
    `Disk: ${report.checks.disk.status}`
  ].join('\n');

  const notifications = [];

  if (channels.includes('slack')) {
    const url = env.SLACK_WEBHOOK_URL || env.ALERT_SLACK_WEBHOOK_URL;
    if (url) {
      try {
        await fetch(url, {
          method: 'POST',
          headers: injectTraceHeaders({
            'content-type': 'application/json'
          }),
          body: JSON.stringify({ text: message })
        });
        notifications.push({ channel: 'slack', status: 'sent' });
      } catch (error) {
        notifications.push({ channel: 'slack', status: 'failed', error: error.message });
      }
    }
  }

  if (channels.includes('email')) {
    const emailTo = env.ALERT_EMAIL_TO || env.HEARTBEAT_EMAIL_TO;
    if (emailTo) {
      notifications.push({
        channel: 'email',
        status: 'queued',
        recipient: emailTo,
        message
      });
    }
  }

  if (notifications.length === 0) {
    notifications.push({ channel: 'console', status: 'skipped' });
  }

  return {
    report,
    notifications
  };
}

function startHeartbeatService(options = {}) {
  const env = options.env || process.env;
  const intervalMs = Number(env.HEARTBEAT_INTERVAL_MS || DEFAULT_INTERVAL_MS);

  if (toBoolean(env.HEARTBEAT_DISABLED, false)) {
    return null;
  }

  const run = async () => {
    try {
      const report = await getDiagnosticReport({ env });
      const result = await sendDiagnosticAlert(report, { env });
      if (result.notifications.some(notification => notification.status !== 'skipped')) {
        logger.info({ report, notifications: result.notifications }, 'heartbeat diagnostic report delivered');
      }
    } catch (error) {
      logger.error({ error: error.message }, 'heartbeat diagnostic run failed');
    }
  };

  run();
  const timer = setInterval(run, intervalMs);

  return {
    timer,
    stop() {
      clearInterval(timer);
    }
  };
}

module.exports = {
  checkDiskAccess,
  checkRedisConnection,
  checkRpcConnection,
  getAlertChannels,
  getDiagnosticReport,
  sendDiagnosticAlert,
  startHeartbeatService
};
