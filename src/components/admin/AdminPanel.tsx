import React, { useState, useEffect, useMemo } from 'react';
import { 
  ShieldAlert, CheckCircle, RefreshCw, XCircle, ShieldCheck, 
  Plus, Check, Play, ArrowRight, Lock, User, FileText, Settings 
} from 'lucide-react';
import { useSimulation, SimulationResult } from '../../hooks/useSimulation';
import './admin.css';

interface MultisigState {
  admins: string[];
  threshold: number;
  nonce: number;
  tasks: number[];
  killed: boolean;
}

interface Proposal {
  hash: string;
  action: string;
  params: any;
  approvals: string[];
  executed: boolean;
}

export default function AdminPanel() {
  const [adminAddress, setAdminAddress] = useState<string>('');
  const [isKilled, setIsKilled] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Multisig State
  const [multisigState, setMultisigState] = useState<MultisigState>({
    admins: [],
    threshold: 2,
    nonce: 0,
    tasks: [],
    killed: false
  });
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedSigner, setSelectedSigner] = useState<string>('');

  // Propose Form State
  const [newAction, setNewAction] = useState<string>('RegisterTask');
  const [prNumber, setPrNumber] = useState<string>('');
  const [newThreshold, setNewThreshold] = useState<string>('');
  const [newAdminsInput, setNewAdminsInput] = useState<string>('');

  // Simulation State Hook Instances
  const proposalSim = useSimulation();
  const approveSim = useSimulation();

  // Selected proposal hash for approval simulation
  const [simulatedProposalHash, setSimulatedProposalHash] = useState<string | null>(null);

  // Fetch full state on mount and reload
  const loadMultisigData = async () => {
    try {
      const stateRes = await fetch('/api/admin/multisig/state');
      const stateData = await stateRes.json();
      setMultisigState(stateData);
      setIsKilled(stateData.killed);

      // Default the selected signer to the first admin if not set
      if (stateData.admins.length > 0 && !selectedSigner) {
        setSelectedSigner(stateData.admins[0]);
      }

      const proposalsRes = await fetch('/api/admin/multisig/proposals');
      const proposalsData = await proposalsRes.json();
      setProposals(proposalsData);
    } catch (err) {
      console.error('Failed to load multisig state:', err);
    }
  };

  useEffect(() => {
    loadMultisigData();
  }, []);

  // Validate address format (Starts with G, base32 characters, length 56)
  const isValidAddress = useMemo(() => {
    const trimmed = adminAddress.trim();
    const stellarAddressRegex = /^G[A-Z2-7]{55}$/;
    return stellarAddressRegex.test(trimmed);
  }, [adminAddress]);

  // Trigger Kill Switch
  const handleTriggerKill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidAddress) {
      setError('Please provide a valid Stellar admin address');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/admin/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminAddress: adminAddress.trim() })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to trigger kill switch');

      setIsKilled(true);
      setSuccessMsg('Kill switch triggered! Contract execution has been successfully halted on-chain.');
      setAdminAddress('');
      loadMultisigData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Reactivate Contract
  const handleReactivate = async () => {
    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/admin/resume', {
        method: 'POST'
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reactivate contract');

      setIsKilled(false);
      setSuccessMsg('Contract successfully reactivated. Operations have resumed.');
      loadMultisigData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Propose form action parameters
  const getProposeParams = () => {
    if (newAction === 'RegisterTask' || newAction === 'PurgeTask') {
      return { pr: Number(prNumber) };
    }
    if (newAction === 'UpdateThreshold') {
      return { threshold: Number(newThreshold) };
    }
    if (newAction === 'UpdateAdmins') {
      return { admins: newAdminsInput.split(',').map(s => s.trim()).filter(Boolean) };
    }
    return {};
  };

  // Run Propose Simulation
  const handleSimulateProposal = async () => {
    if (!selectedSigner) return;
    const params = getProposeParams();
    await proposalSim.simulateProposal(selectedSigner, newAction, params);
  };

  // Submit Proposal
  const handleSubmitProposal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSigner) return;
    setError(null);
    setSuccessMsg(null);

    const params = getProposeParams();

    try {
      const res = await fetch('/api/admin/multisig/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposer: selectedSigner,
          action: newAction,
          params
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit proposal');

      setSuccessMsg(`Proposal successfully created! Hash: ${data.proposal.hash.slice(0, 10)}...`);
      setPrNumber('');
      setNewThreshold('');
      setNewAdminsInput('');
      proposalSim.resetSimulation();
      loadMultisigData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Run Approve Simulation
  const handleSimulateApproval = async (hash: string) => {
    if (!selectedSigner) return;
    setSimulatedProposalHash(hash);
    await approveSim.simulateApproval(selectedSigner, hash);
  };

  // Submit Approval/Signature
  const handleApproveProposal = async (hash: string) => {
    if (!selectedSigner) return;
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/admin/multisig/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approver: selectedSigner,
          hash
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to sign proposal');

      if (data.executed) {
        setSuccessMsg('Proposal reached the multisig threshold and was executed successfully!');
      } else {
        setSuccessMsg('Signature successfully registered.');
      }

      approveSim.resetSimulation();
      setSimulatedProposalHash(null);
      loadMultisigData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="admin-container">
      {/* Background visual indicators */}
      <div className={`status-glow ${isKilled ? 'glow-red' : 'glow-green'}`}></div>

      <div className="admin-grid">
        {/* Status Card */}
        <div className="admin-card glass-panel status-card">
          <div className="card-header">
            <Settings className="header-icon" />
            <h3>Contract Status Indicator</h3>
          </div>
          <div className="status-display">
            <div className={`status-indicator-ring ${isKilled ? 'killed' : 'active'}`}>
              <div className="status-indicator-dot"></div>
            </div>
            <div className="status-labels">
              <div className={`status-badge-large ${isKilled ? 'terminated' : 'active'}`}>
                {isKilled ? 'TERMINATED' : 'OPERATIONAL'}
              </div>
              <p className="status-description">
                {isKilled 
                  ? 'All contract proposal creation, threshold updates, and vote approval endpoints are strictly disabled.'
                  : 'All contract functions are running normally. Multisig proposals can be cast and executed.'}
              </p>
            </div>
          </div>

          {isKilled && (
            <button
              onClick={handleReactivate}
              disabled={loading}
              className="btn-action btn-resume"
              style={{ alignSelf: 'flex-start', marginTop: '16px' }}
            >
              {loading ? <RefreshCw size={18} className="spin-icon" /> : <ShieldCheck size={18} />}
              <span>Reactivate Contract</span>
            </button>
          )}
        </div>

        {/* Trigger Card */}
        <div className="admin-card glass-panel trigger-card">
          <div className="card-header">
            <ShieldAlert className="warning-icon" />
            <h3>Emergency Kill Switch</h3>
          </div>
          
          <p className="emergency-warning">
            Triggering the kill switch is an administrative emergency action. Any single authorized admin address can invoke this, instantly halting all multisig and transaction pipelines.
          </p>

          <form onSubmit={handleTriggerKill} className="kill-form">
            <div className="form-group">
              <label htmlFor="admin-address">Admin Authorization Address</label>
              <input
                id="admin-address"
                type="text"
                placeholder="Enter admin public key (G...)"
                value={adminAddress}
                onChange={(e) => setAdminAddress(e.target.value)}
                disabled={isKilled || loading}
                className="address-input"
              />
              {adminAddress && (
                <span className={`validation-indicator ${isValidAddress ? 'valid' : 'invalid'}`}>
                  {isValidAddress ? 'Valid Address Syntax' : 'Invalid Address (must start with G, length 56)'}
                </span>
              )}
            </div>

            <button
              type="submit"
              disabled={isKilled || loading || !isValidAddress}
              className="btn-action btn-kill"
            >
              {loading ? <RefreshCw size={18} className="spin-icon" /> : <XCircle size={18} />}
              <span>Execute Kill Switch</span>
            </button>
          </form>

          {successMsg && (
            <div className="alert-message alert-success" style={{ marginTop: '12px' }}>
              <CheckCircle size={18} />
              <p>{successMsg}</p>
            </div>
          )}

          {error && (
            <div className="alert-message alert-error" style={{ marginTop: '12px' }}>
              <ShieldAlert size={18} />
              <p>{error}</p>
            </div>
          )}
        </div>
      </div>

      {/* Contract Config Card */}
      <div className="admin-card glass-panel config-summary-card" style={{ marginTop: '24px' }}>
        <div className="card-header">
          <ShieldCheck className="header-icon" />
          <h3>Contract Configuration Summary</h3>
        </div>
        <div className="config-grid">
          <div className="config-item">
            <span className="config-label">Contract Nonce</span>
            <span className="config-value">{multisigState.nonce}</span>
          </div>
          <div className="config-item">
            <span className="config-label">Required Threshold</span>
            <span className="config-value">{multisigState.threshold} of {multisigState.admins.length} approvals</span>
          </div>
          <div className="config-item">
            <span className="config-label">Admins List</span>
            <div className="admins-list">
              {multisigState.admins.map((admin, idx) => (
                <span key={admin} className="admin-key-badge">
                  {admin === selectedSigner && <User size={12} style={{ marginRight: '4px' }} />}
                  Admin {idx + 1}: {admin.slice(0, 8)}...{admin.slice(-6)}
                </span>
              ))}
            </div>
          </div>
          <div className="config-item">
            <span className="config-label">Active Tasks (PRs)</span>
            <div className="tasks-list">
              {multisigState.tasks.length > 0 ? (
                multisigState.tasks.map(task => (
                  <span key={task} className="task-id-badge">PR #{task}</span>
                ))
              ) : (
                <span className="no-tasks-text">No PR tasks currently registered on-chain</span>
              )}
            </div>
          </div>
        </div>

        {/* Global Signer Selection */}
        <div className="signer-selector-box" style={{ marginTop: '20px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <User className="icon-blue" size={18} />
            <label htmlFor="signer-select" style={{ fontWeight: '600' }}>Acting Administrator Signer:</label>
          </div>
          <select
            id="signer-select"
            value={selectedSigner}
            onChange={(e) => {
              setSelectedSigner(e.target.value);
              proposalSim.resetSimulation();
              approveSim.resetSimulation();
            }}
            className="signer-dropdown"
          >
            {multisigState.admins.map((admin, idx) => (
              <option key={admin} value={admin}>
                Admin {idx + 1} ({admin.slice(0, 16)}...)
              </option>
            ))}
          </select>
          <p className="signer-tip">Choose which administrator key will proposed/sign subsequent multisig proposals.</p>
        </div>
      </div>

      {/* Multisig Dashboard */}
      <div className="multisig-dashboard-grid" style={{ marginTop: '24px' }}>
        {/* Proposal Form */}
        <div className="admin-card glass-panel propose-card">
          <div className="card-header">
            <Plus className="header-icon" />
            <h3>Create Admin Multisig Proposal</h3>
          </div>

          <form onSubmit={handleSubmitProposal} className="propose-form">
            <div className="form-group">
              <label htmlFor="action-select">Action Type</label>
              <select
                id="action-select"
                value={newAction}
                onChange={(e) => {
                  setNewAction(e.target.value);
                  proposalSim.resetSimulation();
                }}
                className="action-dropdown"
              >
                <option value="RegisterTask">Register PR Task</option>
                <option value="PurgeTask">Purge PR Task</option>
                <option value="UpdateThreshold">Update Threshold</option>
                <option value="UpdateAdmins">Update Admins</option>
              </select>
            </div>

            {/* Parameter Fields */}
            {(newAction === 'RegisterTask' || newAction === 'PurgeTask') && (
              <div className="form-group">
                <label htmlFor="pr-input">PR Number</label>
                <input
                  id="pr-input"
                  type="number"
                  placeholder="Enter GitHub PR number"
                  value={prNumber}
                  onChange={(e) => {
                    setPrNumber(e.target.value);
                    proposalSim.resetSimulation();
                  }}
                  required
                  className="params-input"
                />
              </div>
            )}

            {newAction === 'UpdateThreshold' && (
              <div className="form-group">
                <label htmlFor="threshold-input">New Threshold (M)</label>
                <input
                  id="threshold-input"
                  type="number"
                  placeholder="Enter required approvals threshold"
                  value={newThreshold}
                  onChange={(e) => {
                    setNewThreshold(e.target.value);
                    proposalSim.resetSimulation();
                  }}
                  required
                  className="params-input"
                />
              </div>
            )}

            {newAction === 'UpdateAdmins' && (
              <div className="form-group">
                <label htmlFor="admins-input">New Admins (Comma Separated)</label>
                <textarea
                  id="admins-input"
                  rows={3}
                  placeholder="Enter Stellar public addresses separated by commas"
                  value={newAdminsInput}
                  onChange={(e) => {
                    setNewAdminsInput(e.target.value);
                    proposalSim.resetSimulation();
                  }}
                  required
                  className="params-input"
                />
              </div>
            )}

            <div className="button-group-row">
              <button
                type="button"
                onClick={handleSimulateProposal}
                disabled={isKilled || (newAction === 'RegisterTask' && !prNumber) || proposalSim.simulating}
                className="btn-action btn-simulate"
              >
                {proposalSim.simulating ? <RefreshCw size={16} className="spin-icon" /> : <Play size={16} />}
                <span>Simulate Proposal Impact</span>
              </button>

              <button
                type="submit"
                disabled={isKilled || (newAction === 'RegisterTask' && !prNumber)}
                className="btn-action btn-propose"
              >
                <Check size={16} />
                <span>Submit Proposal</span>
              </button>
            </div>
          </form>

          {/* Proposal Simulation Results */}
          {proposalSim.result && (
            <div className={`simulation-preview-box ${proposalSim.result.success ? 'success' : 'fail'}`}>
              <div className="sim-title">
                <ShieldCheck size={16} />
                <h4>Proposal Simulation Output</h4>
              </div>

              {!proposalSim.result.success ? (
                <div className="sim-error">
                  <XCircle size={16} />
                  <span>Simulation Failed: {proposalSim.result.error} (Code #{proposalSim.result.code})</span>
                </div>
              ) : (
                <div className="sim-success-body">
                  <div className="sim-outcome">
                    <span className="badge-outcome">STATUS: SIMULATION OK</span>
                    <span className={`badge-exec ${proposalSim.result.willExecute ? 'executing' : 'partial'}`}>
                      {proposalSim.result.willExecute ? 'WILL EXECUTE IMMEDIATELY' : 'REQUIRES MORE APPROVALS'}
                    </span>
                  </div>

                  {proposalSim.result.stateChanges.length > 0 ? (
                    <div className="sim-changes">
                      <h5>Predicted State Transitions:</h5>
                      <div className="changes-diff-list">
                        {proposalSim.result.stateChanges.map((change) => (
                          <div key={change.key} className="diff-item">
                            <span className="diff-key">{change.key}:</span>
                            <span className="diff-before">{change.before}</span>
                            <ArrowRight size={12} className="diff-arrow" />
                            <span className="diff-after">{change.after}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="no-changes-msg">No state transitions occur yet (partial approval threshold not met).</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Proposals List */}
        <div className="admin-card glass-panel proposals-list-card">
          <div className="card-header">
            <FileText className="header-icon" />
            <h3>Active Multisig Proposals</h3>
          </div>

          <div className="proposals-scroll">
            {proposals.length > 0 ? (
              proposals.map((proposal) => {
                const hasSigned = proposal.approvals.includes(selectedSigner);
                return (
                  <div key={proposal.hash} className={`proposal-item ${proposal.executed ? 'executed' : ''}`}>
                    <div className="prop-row-header">
                      <span className="prop-action-label">{proposal.action}</span>
                      <span className={`prop-badge-status ${proposal.executed ? 'exec' : 'pending'}`}>
                        {proposal.executed ? 'Executed' : 'Pending'}
                      </span>
                    </div>

                    <div className="prop-hash">Hash: {proposal.hash}</div>
                    
                    {/* Params view */}
                    <div className="prop-params">
                      <strong>Params:</strong> {JSON.stringify(proposal.params)}
                    </div>

                    <div className="prop-approvals">
                      <strong>Signatures:</strong> {proposal.approvals.length} of {multisigState.threshold} approvals ({proposal.approvals.map(a => a.slice(0, 6)).join(', ')})
                    </div>

                    {!proposal.executed && (
                      <div className="prop-controls">
                        <button
                          onClick={() => handleSimulateApproval(proposal.hash)}
                          disabled={approveSim.simulating}
                          className="btn-small btn-simulate"
                        >
                          {approveSim.simulating && simulatedProposalHash === proposal.hash ? (
                            <RefreshCw size={12} className="spin-icon" />
                          ) : (
                            <Play size={12} />
                          )}
                          <span>Simulate</span>
                        </button>

                        <button
                          onClick={() => handleApproveProposal(proposal.hash)}
                          disabled={hasSigned}
                          className={`btn-small ${hasSigned ? 'btn-signed' : 'btn-approve'}`}
                        >
                          <Check size={12} />
                          <span>{hasSigned ? 'Signed' : 'Sign & Approve'}</span>
                        </button>
                      </div>
                    )}

                    {/* Single Proposal Approval Simulation Output */}
                    {simulatedProposalHash === proposal.hash && approveSim.result && (
                      <div className={`simulation-preview-box small ${approveSim.result.success ? 'success' : 'fail'}`} style={{ marginTop: '12px' }}>
                        <div className="sim-title">
                          <ShieldCheck size={12} />
                          <h4>Signature Simulation</h4>
                        </div>

                        {!approveSim.result.success ? (
                          <div className="sim-error">
                            <XCircle size={12} />
                            <span>Failed: {approveSim.result.error}</span>
                          </div>
                        ) : (
                          <div className="sim-success-body">
                            <div className="sim-outcome">
                              <span className={`badge-exec ${approveSim.result.willExecute ? 'executing' : 'partial'}`} style={{ fontSize: '10px' }}>
                                {approveSim.result.willExecute ? 'WILL EXECUTE CONTRACT IMMEDIATELY' : 'PENDING STAGE'}
                              </span>
                            </div>

                            {approveSim.result.stateChanges.length > 0 && (
                              <div className="changes-diff-list compact">
                                {approveSim.result.stateChanges.map((change) => (
                                  <div key={change.key} className="diff-item">
                                    <span className="diff-key">{change.key}:</span>
                                    <span className="diff-before">{change.before}</span>
                                    <ArrowRight size={10} className="diff-arrow" />
                                    <span className="diff-after">{change.after}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="no-proposals-placeholder">
                <Lock size={36} />
                <p>No active proposals. Create a proposal using the form on the left.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
