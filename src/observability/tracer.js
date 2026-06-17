const { trace, context, propagation } = require('@opentelemetry/api');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { AsyncHooksContextManager } = require('@opentelemetry/context-async-hooks');

// Service name – can be overridden via env var SERVICE_NAME
const SERVICE_NAME = process.env.SERVICE_NAME || 'vero-relayer-service';

// Jaeger endpoint – default to popular collector port if not provided
const JAEGER_ENDPOINT = process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces';

// Initialize the async context manager (preserves context across async callbacks)
const contextManager = new AsyncHooksContextManager();
context.setGlobalContextManager(contextManager.enable());

// Create and configure the tracer provider
const provider = new NodeTracerProvider();
const exporter = new JaegerExporter({
  endpoint: JAEGER_ENDPOINT,
  serviceName: SERVICE_NAME,
});
provider.addSpanProcessor(new (require('@opentelemetry/sdk-trace-base')).BatchSpanProcessor(exporter));
provider.register();

// Register automatic instrumentations for core Node APIs (http, https, net, dns, etc.)
registerInstrumentations({
  instrumentations: [getNodeAutoInstrumentations()],
});

/**
 * Retrieve the global tracer for this service.
 */
function getTracer() {
  return trace.getTracer(SERVICE_NAME);
}

/**
 * Inject tracing headers into an outgoing HTTP request's header object.
 * @param {Object} headers Existing headers object (may be empty).
 * @returns {Object} The same headers object with traceparent and tracestate added.
 */
function injectTraceHeaders(headers = {}) {
  const carrier = { ...headers };
  propagation.inject(context.active(), carrier);
  return carrier;
}

module.exports = { getTracer, injectTraceHeaders, provider };
