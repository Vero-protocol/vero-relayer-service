import { Router, Request, Response } from 'express';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDiagnosticReport } = require('../services/diagnostics');

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const report = await getDiagnosticReport();
    const httpStatus = report.summary.ok ? 200 : 503;

    res.status(httpStatus).json({
      status: report.summary.ok ? 'ok' : 'degraded',
      checkedAt: report.summary.checkedAt,
      checks: {
        db: {
          status: report.checks.db.status,
          ok: report.checks.db.ok,
          latencyMs: report.checks.db.latencyMs,
        },
        rpc: {
          status: report.checks.rpc.status,
          ok: report.checks.rpc.ok,
          latencyMs: report.checks.rpc.latencyMs,
        },
      },
    });
  } catch {
    res.status(503).json({
      status: 'error',
      checkedAt: new Date().toISOString(),
    });
  }
});

export default router;
