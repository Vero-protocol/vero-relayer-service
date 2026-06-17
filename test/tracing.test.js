const assert = require('node:assert/strict');
const { test } = require('node:test');
const { context, trace, TraceFlags } = require('@opentelemetry/api');
const { injectTraceHeaders } = require('../src/tracing');

function createTestContext() {
  return trace.setSpanContext(context.active(), {
    traceId: '1234567890abcdef1234567890abcdef',
    spanId: '1234567890abcdef',
    traceFlags: TraceFlags.SAMPLED
  });
}

test('injectTraceHeaders adds a traceparent header for the active span', () => {
  const headers = injectTraceHeaders({}, createTestContext());

  assert.ok(headers.traceparent, 'traceparent header should be present');
  assert.match(
    headers.traceparent,
    /^00-1234567890abcdef1234567890abcdef-1234567890abcdef-01$/i
  );
});

test('injectTraceHeaders preserves existing headers and injects trace context', () => {
  const headers = injectTraceHeaders({ authorization: 'Bearer token' }, createTestContext());

  assert.equal(headers.authorization, 'Bearer token');
  assert.ok(headers.traceparent);
  assert.match(headers.traceparent, /^00-/);
});
