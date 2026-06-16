const request = require('supertest');
const app = require('./index');
const { vero_events_processed_total, queue_latency_seconds } = require('./src/metrics/metrics');

describe('Vero Relayer Service Metrics', () => {
  beforeEach(() => {
    // Reset custom metrics before each test to have clean state
    vero_events_processed_total.reset();
    queue_latency_seconds.reset();
  });

  test('GET /metrics should return 200 and prometheus metrics format', async () => {
    const res = await request(app).get('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });

  test('POST /github-webhook should increment metrics on valid event', async () => {
    const payload = {
      action: 'closed',
      pull_request: {
        number: 101,
        merged: true,
        labels: [{ name: 'wave-contribution' }]
      }
    };

    const res = await request(app)
      .post('/github-webhook')
      .send(payload)
      .set('Content-Type', 'application/json');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, pr: 101 });

    // Verify metrics endpoint output contains our custom metrics
    const metricsRes = await request(app).get('/metrics');
    expect(metricsRes.text).toContain('vero_events_processed_total 1');
    expect(metricsRes.text).toContain('queue_latency_seconds_count 1');
  });

  test('POST /github-webhook should not increment metrics on skipped event', async () => {
    const payload = {
      action: 'opened',
      pull_request: {
        number: 102,
        merged: false,
        labels: [{ name: 'wave-contribution' }]
      }
    };

    const res = await request(app)
      .post('/github-webhook')
      .send(payload)
      .set('Content-Type', 'application/json');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ skipped: true });

    const metricsRes = await request(app).get('/metrics');
    // Ensure our custom metrics are NOT incremented
    expect(metricsRes.text).not.toContain('vero_events_processed_total 1');
  });
});
