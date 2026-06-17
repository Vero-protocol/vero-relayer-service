import { useState } from 'react';

export interface SimulationStateChange {
  key: string;
  before: string;
  after: string;
}

export interface SimulationResult {
  success: boolean;
  error?: string;
  code?: number;
  willExecute: boolean;
  stateChanges: SimulationStateChange[];
  nonceAfter?: number;
}

export interface SimulationPayload {
  type: 'propose' | 'approve';
  signer: string;
  action?: string;
  params?: any;
  hash?: string;
}

export function useSimulation() {
  const [simulating, setSimulating] = useState<boolean>(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runSimulation = async (payload: SimulationPayload): Promise<SimulationResult | null> => {
    setSimulating(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/admin/multisig/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        throw new Error('Simulation network request failed');
      }

      const data: SimulationResult = await res.json();
      setResult(data);
      return data;
    } catch (err: any) {
      const msg = err.message || 'Failed to connect to simulation server';
      setError(msg);
      const fallbackResult: SimulationResult = {
        success: false,
        error: msg,
        willExecute: false,
        stateChanges: []
      };
      setResult(fallbackResult);
      return fallbackResult;
    } finally {
      setSimulating(false);
    }
  };

  const simulateProposal = (signer: string, action: string, params: any) => {
    return runSimulation({ type: 'propose', signer, action, params });
  };

  const simulateApproval = (signer: string, hash: string) => {
    return runSimulation({ type: 'approve', signer, hash });
  };

  const resetSimulation = () => {
    setResult(null);
    setError(null);
    setSimulating(false);
  };

  return {
    simulating,
    result,
    error,
    simulateProposal,
    simulateApproval,
    resetSimulation
  };
}
