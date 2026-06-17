const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('../index');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      resolve(server);
    });
  });
}

function close(server) {
  return new Promise(resolve => {
    server.close(resolve);
  });
}

function url(server, path) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}${path}`;
}

test('multisig state and dry-run simulation flow', async t => {
  const app = createApp();
  const server = await listen(app);
  t.after(() => close(server));

  const admin1 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
  const admin2 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2';
  const outsider = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9';

  // 1. Get Initial state
  const stateRes1 = await fetch(url(server, '/api/admin/multisig/state'));
  assert.equal(stateRes1.status, 200);
  const state1 = await stateRes1.json();
  assert.equal(state1.threshold, 2);
  assert.equal(state1.nonce, 0);
  assert.deepEqual(state1.tasks, []);

  // 2. Try to simulate proposal by outsider -> fails
  const simResOutsider = await fetch(url(server, '/api/admin/multisig/simulate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'propose',
      signer: outsider,
      action: 'RegisterTask',
      params: { pr: 100 }
    })
  });
  assert.equal(simResOutsider.status, 200);
  const simOutsider = await simResOutsider.json();
  assert.equal(simOutsider.success, false);
  assert.equal(simOutsider.code, 1); // Unauthorized code

  // 3. Dry-run simulate proposal by admin1 (should succeed, but not execute immediately since threshold = 2)
  const simRes1 = await fetch(url(server, '/api/admin/multisig/simulate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'propose',
      signer: admin1,
      action: 'RegisterTask',
      params: { pr: 100 }
    })
  });
  assert.equal(simRes1.status, 200);
  const sim1 = await simRes1.json();
  assert.equal(sim1.success, true);
  assert.equal(sim1.willExecute, false);
  assert.deepEqual(sim1.stateChanges, [
    { key: 'Approvals Count', before: '0 / 2', after: '1 / 2' }
  ]);

  // 4. Create actual proposal by admin1
  const proposeRes = await fetch(url(server, '/api/admin/multisig/propose'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proposer: admin1,
      action: 'RegisterTask',
      params: { pr: 100 }
    })
  });
  assert.equal(proposeRes.status, 200);
  const proposalBody = await proposeRes.json();
  assert.equal(proposalBody.ok, true);
  const hash = proposalBody.proposal.hash;
  assert.ok(hash);

  // 5. Dry-run simulate approval by admin2 (should result in execution!)
  const simRes2 = await fetch(url(server, '/api/admin/multisig/simulate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'approve',
      signer: admin2,
      hash: hash
    })
  });
  assert.equal(simRes2.status, 200);
  const sim2 = await simRes2.json();
  assert.equal(sim2.success, true);
  assert.equal(sim2.willExecute, true);
  assert.deepEqual(sim2.stateChanges, [
    { key: 'Approvals Count', before: '1 / 2', after: '2 / 2' },
    { key: 'Task #100', before: 'Not Registered', after: 'Registered' },
    { key: 'Contract Nonce', before: '0', after: '1' }
  ]);

  // 6. Execute actual approval/signature by admin2
  const approveRes = await fetch(url(server, '/api/admin/multisig/approve'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      approver: admin2,
      hash: hash
    })
  });
  assert.equal(approveRes.status, 200);
  const approveBody = await approveRes.json();
  assert.equal(approveBody.ok, true);
  assert.equal(approveBody.executed, true);

  // 7. Verify state is updated
  const stateRes2 = await fetch(url(server, '/api/admin/multisig/state'));
  const state2 = await stateRes2.json();
  assert.equal(state2.nonce, 1);
  assert.deepEqual(state2.tasks, [100]);

  // 8. Kill contract
  await fetch(url(server, '/api/admin/kill'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
  });

  // 9. Simulating on a killed contract should fail with Code 8
  const simResKilled = await fetch(url(server, '/api/admin/multisig/simulate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'propose',
      signer: admin1,
      action: 'RegisterTask',
      params: { pr: 101 }
    })
  });
  const simKilled = await simResKilled.json();
  assert.equal(simKilled.success, false);
  assert.equal(simKilled.code, 8);
});
