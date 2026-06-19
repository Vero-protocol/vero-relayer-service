const { defaultIsRetryable } = require('../utils/retry');

class StellarServiceUnavailableError extends Error {
  constructor(message = 'Stellar service temporarily unavailable', options = {}) {
    super(message);
    this.name = 'StellarServiceUnavailableError';
    this.code = 'STELLAR_SERVICE_UNAVAILABLE';
    this.statusCode = 503;
    this.retryable = true;
    this.operation = options.operation || 'stellar';

    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function isServiceUnavailableError(error) {
  if (!error) {
    return false;
  }

  return error instanceof StellarServiceUnavailableError ||
    error.code === 'STELLAR_SERVICE_UNAVAILABLE' ||
    Number(error.statusCode || error.status) === 503;
}

function isTransientNetworkError(error) {
  if (!error) {
    return false;
  }

  if (defaultIsRetryable(error)) {
    return true;
  }

  return error.cause ? isTransientNetworkError(error.cause) : false;
}

function toStellarServiceUnavailable(error, operation) {
  if (isServiceUnavailableError(error)) {
    return error;
  }

  if (!isTransientNetworkError(error)) {
    return error;
  }

  return new StellarServiceUnavailableError('Stellar service temporarily unavailable', {
    cause: error,
    operation
  });
}

function getHttpStatusForError(error) {
  return isServiceUnavailableError(error) || isTransientNetworkError(error) ? 503 : 500;
}

module.exports = {
  StellarServiceUnavailableError,
  getHttpStatusForError,
  isServiceUnavailableError,
  isTransientNetworkError,
  toStellarServiceUnavailable
};
