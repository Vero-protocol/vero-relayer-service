const { setTimeout } = require('timers/promises');

function defaultIsRetryable(err) {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    const code = String(err.code || '').toLowerCase();
    const status = Number(err.status || err.statusCode || (err.response && (err.response.status || err.response.statusCode)));

    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('fetch failed') || msg.includes('socket hang up') || msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('eai_again') || msg.includes('enotfound') || msg.includes('network') || msg.includes('rate limit')) {
      return true;
    }
    if (code === 'econnrefused' || code === 'econnreset' || code === 'etimedout' || code === 'eai_again' || code === 'enotfound') {
      return true;
    }
    if (err.code === 429 || err.code === 503 || err.code === 502 || status === 408 || status === 429 || status === 502 || status === 503 || status === 504) {
      return true;
    }
  }
  return false;
}

async function retry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    isRetryable = defaultIsRetryable,
    onRetry = null,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries || !isRetryable(err)) {
        throw err;
      }
      const delay = baseDelay * Math.pow(2, attempt);
      if (onRetry) {
        onRetry({ attempt, delay, error: err });
      }
      await setTimeout(delay);
    }
  }

  throw lastError;
}

module.exports = { retry, defaultIsRetryable };
