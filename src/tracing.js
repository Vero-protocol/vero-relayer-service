const { context, propagation, trace, SpanKind, SpanStatusCode } = require('@opentelemetry/api');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');

let sdk;

function normalizeEndpoint(url) {
  if (!url) {
    return null;
  }

  const trimmed = String(url).trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.endsWith('/v1/traces')
    ? trimmed
    : `${trimmed.replace(/\/$/, '')}/v1/traces`;
}

function initializeTracing() {
  if (sdk || process.env.OTEL_SDK_DISABLED === 'true') {
    return sdk;
  }

  const serviceName = process.env.OTEL_SERVICE_NAME || 'vero-relayer-service';
  const endpoint = normalizeEndpoint(
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  );

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName
    }),
    traceExporter: endpoint
      ? new OTLPTraceExporter({ url: endpoint })
      : undefined,
    instrumentations: [getNodeAutoInstrumentations()]
  });

  sdk.start();

  process.once('SIGTERM', async () => {
    await sdk.shutdown();
  });

  return sdk;
}

function getRequestPath(req) {
  const rawUrl = req.originalUrl || req.url || '';

  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch (_) {
    return rawUrl.split('?')[0];
  }
}

function requestTracingMiddleware(tracer = trace.getTracer('vero-relayer-service')) {
  return function requestTracing(req, res, next) {
    const path = getRequestPath(req);
    const span = tracer.startSpan(`${req.method || 'HTTP'} ${path}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'http.method': req.method || 'UNKNOWN',
        'http.route': path,
        'http.scheme': req.protocol || 'http',
        'http.host': req.get?.('host') || 'unknown'
      }
    });

    const spanContext = trace.setSpan(context.active(), span);
    req.span = span;
    req.traceContext = spanContext;

    res.setHeader('x-trace-id', span.spanContext().traceId);

    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      if (res.statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    });

    context.with(spanContext, () => {
      next();
    });
  };
}

function injectTraceHeaders(headers = {}, contextToInject = context.active()) {
  const spanContext = trace.getSpanContext(contextToInject);

  if (!spanContext || !spanContext.traceId || !spanContext.spanId) {
    return headers;
  }

  const traceparent = [
    '00',
    spanContext.traceId,
    spanContext.spanId,
    spanContext.traceFlags.toString(16).padStart(2, '0')
  ].join('-');

  return {
    ...headers,
    traceparent,
    ...(spanContext.traceState?.serialize?.() ? { tracestate: spanContext.traceState.serialize() } : {})
  };
}

module.exports = {
  initializeTracing,
  injectTraceHeaders,
  requestTracingMiddleware
};
