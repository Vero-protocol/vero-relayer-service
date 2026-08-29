'use strict';

// Single source of truth for JWT error codes and their default HTTP status.
// Add new codes here ONLY — jwt.js and jwt-auth.js both read from this map.
const JWT_ERROR_CODES = Object.freeze({
  MISSING_TOKEN: Object.freeze({ code: 'MISSING_TOKEN', status: 401 }),
  MALFORMED_TOKEN: Object.freeze({ code: 'MALFORMED_TOKEN', status: 401 }),
  INVALID_ALGORITHM: Object.freeze({ code: 'INVALID_ALGORITHM', status: 401 }),
  INVALID_SIGNATURE: Object.freeze({ code: 'INVALID_SIGNATURE', status: 401 }),
  TOKEN_EXPIRED: Object.freeze({ code: 'TOKEN_EXPIRED', status: 401 }),
  TOKEN_NOT_YET_VALID: Object.freeze({ code: 'TOKEN_NOT_YET_VALID', status: 401 }),
  INVALID_ISSUER: Object.freeze({ code: 'INVALID_ISSUER', status: 401 }),
});

function statusForCode(code, fallback = 401) {
  return JWT_ERROR_CODES[code] ? JWT_ERROR_CODES[code].status : fallback;
}

module.exports = { JWT_ERROR_CODES, statusForCode };