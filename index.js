const express = require('express');
const {
  buildGitHubPullRequestEventPayload,
  buildMetadataFromRequest,
  enqueueEvent,
  validateRedisConfig
} = require('./src/queue');
const { verifySignature } = require('./src/middleware/auth');
const { registerMetrics } = require('./src/metrics/metrics');
const { logger } = require('./src/logger');
const { startConfigPoller } = require('./src/services/config-poller');
const path = require('path');
const { generateCallGraph } = require('./src/services/call-graph');

function createApp(options = {}) {
  const enqueueEventJob = options.enqueueEventJob || enqueueEvent;
  const app = express();

  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  registerMetrics(app);

  app.get('/health', (req, res) => {
    res.status(200).send('OK');
  });

  app.get('/api/contract-calls', (req, res) => {
    try {
      const graph = generateCallGraph(path.join(__dirname, 'contracts'));
      res.json(graph);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to generate contract call graph');
      res.status(500).json({ error: 'Failed to generate contract call graph' });
    }
  });

  let contractKilled = false;
  let admins = [
    'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1',
    'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
    'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3'
  ];
  let threshold = 2;
  let nonce = 0;
  let tasks = {};
  let proposals = [];

  function generateProposalHash(action, params) {
    const dataString = `${nonce}:${action}:${JSON.stringify(params)}`;
    const crypto = require('crypto');
    return '0x' + crypto.createHash('sha256').update(dataString).digest('hex');
  }

  function executeAdminAction(action, params) {
    if (action === 'RegisterTask') {
      const pr = Number(params.pr);
      if (isNaN(pr) || pr <= 0) throw new Error('Invalid PR number');
      tasks[pr] = true;
    } else if (action === 'PurgeTask') {
      const pr = Number(params.pr);
      delete tasks[pr];
    } else if (action === 'UpdateThreshold') {
      const m = Number(params.threshold);
      if (isNaN(m) || m <= 0 || m > admins.length) {
        const err = new Error('Invalid threshold');
        err.code = 4;
        throw err;
      }
      threshold = m;
    } else if (action === 'UpdateAdmins') {
      const newAdmins = params.admins;
      if (!Array.isArray(newAdmins) || newAdmins.length === 0) {
        const err = new Error('Empty admin set');
        err.code = 3;
        throw err;
      }
      admins = newAdmins;
      if (threshold > admins.length) {
        threshold = admins.length;
      }
    } else {
      throw new Error('Unknown action type');
    }
  }

  app.get('/api/admin/status', (req, res) => {
    res.json({ killed: contractKilled });
  });

  app.post('/api/admin/kill', (req, res) => {
    const { adminAddress } = req.body;
    if (!adminAddress || adminAddress.trim() === '') {
      return res.status(400).json({ error: 'Admin address is required' });
    }

    const stellarAddressRegex = /^G[A-Z2-7]{55}$/;
    if (!stellarAddressRegex.test(adminAddress)) {
      return res.status(400).json({ error: 'Invalid Stellar admin address format' });
    }

    contractKilled = true;
    logger.warn({ adminAddress }, 'Admin triggered contract kill switch');
    res.json({ ok: true, message: 'Contract successfully killed' });
  });

  app.post('/api/admin/resume', (req, res) => {
    contractKilled = false;
    logger.info('Contract kill switch reset, service active');
    res.json({ ok: true, message: 'Contract successfully reactivated' });
  });

  app.get('/api/admin/multisig/state', (req, res) => {
    res.json({
      admins,
      threshold,
      nonce,
      tasks: Object.keys(tasks).map(Number),
      killed: contractKilled
    });
  });

  app.get('/api/admin/multisig/proposals', (req, res) => {
    res.json(proposals);
  });

  app.post('/api/admin/multisig/propose', (req, res) => {
    if (contractKilled) {
      return res.status(400).json({ error: 'Contract is terminated (killed)', code: 8 });
    }

    const { proposer, action, params } = req.body;
    if (!proposer || !action || !params) {
      return res.status(400).json({ error: 'Proposer, action and params are required' });
    }

    if (!admins.includes(proposer)) {
      return res.status(411).json({ error: 'Unauthorized signer address', code: 1 });
    }

    const hash = generateProposalHash(action, params);

    if (proposals.some(p => p.hash === hash)) {
      return res.status(400).json({ error: 'Proposal already exists', code: 6 });
    }

    const newProposal = {
      hash,
      action,
      params,
      approvals: [proposer],
      executed: false
    };

    proposals.push(newProposal);
    res.json({ ok: true, proposal: newProposal });
  });

  app.post('/api/admin/multisig/approve', (req, res) => {
    if (contractKilled) {
      return res.status(400).json({ error: 'Contract is terminated (killed)', code: 8 });
    }

    const { approver, hash } = req.body;
    if (!approver || !hash) {
      return res.status(400).json({ error: 'Approver and proposal hash are required' });
    }

    if (!admins.includes(approver)) {
      return res.status(411).json({ error: 'Unauthorized signer address', code: 1 });
    }

    const proposal = proposals.find(p => p.hash === hash);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found', code: 5 });
    }

    if (proposal.executed) {
      return res.status(400).json({ error: 'Proposal already executed', code: 7 });
    }

    if (!proposal.approvals.includes(approver)) {
      proposal.approvals.push(approver);
    }

    let executed = false;
    if (proposal.approvals.length >= threshold) {
      executed = true;
      proposal.executed = true;

      try {
        executeAdminAction(proposal.action, proposal.params);
        nonce += 1;
      } catch (err) {
        proposal.executed = false;
        return res.status(400).json({ error: err.message, code: err.code || 4 });
      }
    }

    res.json({ ok: true, proposal, executed });
  });

  app.post('/api/admin/multisig/simulate', (req, res) => {
    if (contractKilled) {
      return res.json({
        success: false,
        error: 'Contract is terminated (killed)',
        code: 8,
        willExecute: false,
        stateChanges: []
      });
    }

    const { type, signer, action, params, hash } = req.body;

    if (!signer) {
      return res.status(400).json({ error: 'Signer/Proposer address is required' });
    }

    if (!admins.includes(signer)) {
      return res.json({
        success: false,
        error: 'Unauthorized signer address',
        code: 1,
        willExecute: false,
        stateChanges: []
      });
    }

    let willExecute = false;
    let simulatedApprovals = [];
    let targetAction = action;
    let targetParams = params;

    if (type === 'propose') {
      const mockHash = generateProposalHash(action, params);
      if (proposals.some(p => p.hash === mockHash)) {
        return res.json({
          success: false,
          error: 'Proposal already exists',
          code: 6,
          willExecute: false,
          stateChanges: []
        });
      }
      simulatedApprovals = [signer];
      willExecute = simulatedApprovals.length >= threshold;
    } else if (type === 'approve') {
      const proposal = proposals.find(p => p.hash === hash);
      if (!proposal) {
        return res.json({
          success: false,
          error: 'Proposal not found',
          code: 5,
          willExecute: false,
          stateChanges: []
        });
      }
      if (proposal.executed) {
        return res.json({
          success: false,
          error: 'Proposal already executed',
          code: 7,
          willExecute: false,
          stateChanges: []
        });
      }
      simulatedApprovals = [...proposal.approvals];
      if (!simulatedApprovals.includes(signer)) {
        simulatedApprovals.push(signer);
      }
      willExecute = simulatedApprovals.length >= threshold;
      targetAction = proposal.action;
      targetParams = proposal.params;
    } else {
      return res.status(400).json({ error: 'Invalid simulation type' });
    }

    const stateChanges = [];

    const currentProposal = type === 'approve' ? proposals.find(p => p.hash === hash) : null;
    const approvalsBefore = currentProposal ? currentProposal.approvals.length : 0;
    const approvalsAfter = simulatedApprovals.length;
    if (approvalsBefore !== approvalsAfter) {
      stateChanges.push({
        key: 'Approvals Count',
        before: `${approvalsBefore} / ${threshold}`,
        after: `${approvalsAfter} / ${threshold}`
      });
    }

    if (willExecute) {
      try {
        if (targetAction === 'RegisterTask') {
          const pr = Number(targetParams.pr);
          if (isNaN(pr) || pr <= 0) throw new Error('Invalid PR number');
          stateChanges.push({
            key: `Task #${pr}`,
            before: 'Not Registered',
            after: 'Registered'
          });
        } else if (targetAction === 'PurgeTask') {
          const pr = Number(targetParams.pr);
          stateChanges.push({
            key: `Task #${pr}`,
            before: tasks[pr] ? 'Registered' : 'Not Registered',
            after: 'Not Registered (Purged)'
          });
        } else if (targetAction === 'UpdateThreshold') {
          const m = Number(targetParams.threshold);
          if (isNaN(m) || m <= 0 || m > admins.length) {
            const err = new Error('Invalid threshold');
            err.code = 4;
            throw err;
          }
          stateChanges.push({
            key: 'Multisig Threshold',
            before: threshold.toString(),
            after: m.toString()
          });
        } else if (targetAction === 'UpdateAdmins') {
          const newAdmins = targetParams.admins;
          if (!Array.isArray(newAdmins) || newAdmins.length === 0) {
            const err = new Error('Empty admin set');
            err.code = 3;
            throw err;
          }
          stateChanges.push({
            key: 'Admin Set',
            before: admins.join(', '),
            after: newAdmins.join(', ')
          });
          if (threshold > newAdmins.length) {
            stateChanges.push({
              key: 'Multisig Threshold (Auto-adjusted)',
              before: threshold.toString(),
              after: newAdmins.length.toString()
            });
          }
        } else {
          throw new Error('Unknown action type');
        }

        stateChanges.push({
          key: 'Contract Nonce',
          before: nonce.toString(),
          after: (nonce + 1).toString()
        });
      } catch (err) {
        return res.json({
          success: false,
          error: err.message,
          code: err.code || 4,
          willExecute: false,
          stateChanges: []
        });
      }
    }

    res.json({
      success: true,
      willExecute,
      stateChanges,
      nonceAfter: willExecute ? nonce + 1 : nonce
    });
  });

  // Serve static files from Vite's build directory
  app.use(express.static(path.join(__dirname, 'dist')));

  // Fallback to index.html for SPA frontend routing
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/health' || req.path === '/metrics') {
      return next();
    }
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });

  app.post('/github-webhook', verifySignature, async (req, res) => {
    const { action, pull_request: pr } = req.body;

    if (action !== 'closed' || !pr?.merged) {
      return res.status(200).json({ skipped: true });
    }

    const hasLabel = pr.labels?.some(l => l.name === 'wave-contribution');
    if (!hasLabel) {
      return res.status(200).json({ skipped: true, reason: 'no wave-contribution label' });
    }

    const eventPayload = buildGitHubPullRequestEventPayload(req.body, buildMetadataFromRequest(req));

    try {
      const job = await enqueueEventJob(eventPayload);
      logger.info({ pr: pr.number, eventType: eventPayload.eventType, jobId: job.id }, '[webhook] queued PR event');
      return res.status(202).json({ ok: true, pr: pr.number, queued: true, jobId: job.id });
    } catch (error) {
      logger.error({ pr: pr.number, error: error.message }, '[webhook] failed to enqueue PR');
      return res.status(500).json({ ok: false, error: 'failed to enqueue event' });
    }
  });

  return app;
}

function startServer() {
  validateRedisConfig();
  startConfigPoller();

  const port = process.env.PORT || 3000;
  const app = createApp();

  return app.listen(port, () => logger.info({ port }, 'Server listening on port'));
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer
};
