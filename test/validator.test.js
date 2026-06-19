'use strict';
/**
 * test/validator.test.js
 *
 * Tests for src/middleware/validator.ts
 * Runs with: node --test test/validator.test.js
 *
 * Loads the validator via ts-node when available, otherwise falls back
 * to the compiled output in dist/.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------
function loadValidator() {
  // Plain JS build — works with node --test out of the box
  try {
    return require('../src/middleware/validator.js');
  } catch {}

  // Try ts-node (when available in dev)
  try {
    require('ts-node/register');
    return require('../src/middleware/validator');
  } catch {}

  // Fall back to compiled TS output
  try {
    return require('../dist/src/middleware/validator');
  } catch {}

  throw new Error('Cannot load validator module.');
}

const { validate, validateTaskPayload } = loadValidator();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function validPayload() {
  return {
    action: 'closed',
    pull_request: {
      id: 1,
      node_id: 'PR_abc123',
      number: 42,
      merged: true,
      labels: [{ id: 10, name: 'wave-contribution' }],
    },
    repository: {
      id: 99,
      name: 'vero-relayer-service',
      full_name: 'org/vero-relayer-service',
    },
  };
}

function makeMockRes() {
  return {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
}

// ---------------------------------------------------------------------------
// validate() — positive cases
// ---------------------------------------------------------------------------
describe('validate() — positive cases', () => {
  test('accepts a fully valid payload', () => {
    const result = validate(validPayload());
    assert.equal(result.success, true);
    assert.equal(result.data.action, 'closed');
    assert.equal(result.data.pull_request.number, 42);
  });

  test('defaults labels to [] when omitted', () => {
    const payload = validPayload();
    delete payload.pull_request.labels;
    const result = validate(payload);
    assert.equal(result.success, true);
    assert.deepEqual(result.data.pull_request.labels, []);
  });

  test('accepts null repository', () => {
    const payload = validPayload();
    payload.repository = null;
    const result = validate(payload);
    assert.equal(result.success, true);
    assert.equal(result.data.repository, null);
  });

  test('accepts payload without optional repository field', () => {
    const payload = validPayload();
    delete payload.repository;
    const result = validate(payload);
    assert.equal(result.success, true);
  });

  test('accepts label without optional id field', () => {
    const payload = validPayload();
    payload.pull_request.labels = [{ name: 'bug' }];
    const result = validate(payload);
    assert.equal(result.success, true);
    assert.equal(result.data.pull_request.labels[0].name, 'bug');
  });

  test('trims whitespace from action', () => {
    const payload = { ...validPayload(), action: '  closed  ' };
    const result = validate(payload);
    assert.equal(result.success, true);
    assert.equal(result.data.action, 'closed');
  });
});

// ---------------------------------------------------------------------------
// validate() — negative cases
// ---------------------------------------------------------------------------
describe('validate() — negative cases', () => {
  test('rejects null payload', () => {
    const result = validate(null);
    assert.equal(result.success, false);
    assert.ok(result.errors.length > 0);
  });

  test('rejects string payload', () => {
    const result = validate('not an object');
    assert.equal(result.success, false);
  });

  test('rejects array payload', () => {
    const result = validate([validPayload()]);
    assert.equal(result.success, false);
  });

  test('rejects missing action field', () => {
    const payload = validPayload();
    delete payload.action;
    const result = validate(payload);
    assert.equal(result.success, false);
    assert.ok(result.errors.some(e => e.path === 'action'));
  });

  test('rejects empty string action', () => {
    const result = validate({ ...validPayload(), action: '   ' });
    assert.equal(result.success, false);
    assert.ok(result.errors.some(e => e.path === 'action'));
  });

  test('rejects missing pull_request field', () => {
    const payload = validPayload();
    delete payload.pull_request;
    const result = validate(payload);
    assert.equal(result.success, false);
    assert.ok(result.errors.some(e => e.path === 'pull_request'));
  });

  test('rejects non-integer PR number (float)', () => {
    const payload = validPayload();
    payload.pull_request.number = 3.14;
    const result = validate(payload);
    assert.equal(result.success, false);
    assert.ok(result.errors.some(e => e.path === 'pull_request.number'));
  });

  test('rejects negative PR number', () => {
    const payload = validPayload();
    payload.pull_request.number = -5;
    const result = validate(payload);
    assert.equal(result.success, false);
    assert.ok(result.errors.some(e => e.path === 'pull_request.number'));
  });

  test('rejects zero PR number', () => {
    const payload = validPayload();
    payload.pull_request.number = 0;
    const result = validate(payload);
    assert.equal(result.success, false);
    assert.ok(result.errors.some(e => e.path === 'pull_request.number'));
  });

  test('rejects string PR number', () => {
    const payload = validPayload();
    payload.pull_request.number = 'forty-two';
    const result = validate(payload);
    assert.equal(result.success, false);
    assert.ok(result.errors.some(e => e.path === 'pull_request.number'));
  });

  test('rejects missing merged field', () => {
    const payload = validPayload();
    delete payload.pull_request.merged;
    const result = validate(payload);
    assert.equal(result.success, false);
    assert.ok(result.errors.some(e => e.path === 'pull_request.merged'));
  });

  test('rejects non-boolean merged ("yes")', () => {
    const payload = validPayload();
    payload.pull_request.merged = 'yes';
    const result = validate(payload);
    assert.equal(result.success, false);
    assert.ok(result.errors.some(e => e.path === 'pull_request.merged'));
  });

  test('rejects non-boolean merged (1)', () => {
    const payload = validPayload();
    payload.pull_request.merged = 1;
    const result = validate(payload);
    assert.equal(result.success, false);
    assert.ok(result.errors.some(e => e.path === 'pull_request.merged'));
  });

  test('rejects label with empty name', () => {
    const payload = validPayload();
    payload.pull_request.labels = [{ name: '' }];
    const result = validate(payload);
    assert.equal(result.success, false);
    assert.ok(result.errors.some(e => e.path.startsWith('pull_request.labels')));
  });

  test('rejects label with missing name', () => {
    const payload = validPayload();
    payload.pull_request.labels = [{ id: 1 }];
    const result = validate(payload);
    assert.equal(result.success, false);
    assert.ok(result.errors.some(e => e.path.includes('name')));
  });

  // ------------------------------------------------------------------
  // Security: parameter injection — unknown properties must be stripped
  // ------------------------------------------------------------------
  test('strips unknown top-level property (injection guard)', () => {
    const result = validate({ ...validPayload(), injected: 'evil' });
    assert.equal(result.success, true);
    assert.equal(result.data.injected, undefined);
  });

  test('strips unknown property nested in pull_request', () => {
    const payload = validPayload();
    payload.pull_request.adminOverride = true;
    const result = validate(payload);
    assert.equal(result.success, true);
    assert.equal(result.data.pull_request.adminOverride, undefined);
  });

  test('strips unknown property nested in repository', () => {
    const payload = validPayload();
    payload.repository.secret_token = 'abc';
    const result = validate(payload);
    assert.equal(result.success, true);
    assert.equal(result.data.repository.secret_token, undefined);
  });

  test('strips unknown property nested in label', () => {
    const payload = validPayload();
    payload.pull_request.labels = [{ name: 'valid', exploit: 'x' }];
    const result = validate(payload);
    assert.equal(result.success, true);
    assert.equal(result.data.pull_request.labels[0].exploit, undefined);
  });
});

// ---------------------------------------------------------------------------
// validateTaskPayload() middleware
// ---------------------------------------------------------------------------
describe('validateTaskPayload() middleware', () => {
  test('calls next() and attaches coerced body on valid payload', () => {
    let nextCalled = false;
    const req = { body: validPayload() };
    const res = makeMockRes();
    validateTaskPayload(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res._status, null, 'should not have set a status code');
    assert.equal(req.body.pull_request.number, 42);
  });

  test('responds 400 and does not call next() on invalid payload', () => {
    let nextCalled = false;
    const req = { body: { action: 'closed' } }; // missing pull_request
    const res = makeMockRes();
    validateTaskPayload(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res._status, 400);
    assert.ok(res._body.error);
    assert.ok(Array.isArray(res._body.details));
    assert.ok(res._body.details.length > 0);
  });

  test('strips parameter injection attempt before calling next()', () => {
    let nextCalled = false;
    const req = { body: { ...validPayload(), extraField: 'injected' } };
    const res = makeMockRes();
    validateTaskPayload(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res._status, null);
    assert.equal(req.body.extraField, undefined);
  });

  test('responds 400 on null payload', () => {
    let nextCalled = false;
    const req = { body: null };
    const res = makeMockRes();
    validateTaskPayload(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res._status, 400);
  });
});
