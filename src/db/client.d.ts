import type { Pool } from 'pg';

export const pool: Pool;
export function healthCheck(): Promise<{
  healthy: boolean;
  latencyMs?: number;
  pool: {
    total: number;
    idle: number;
    waiting: number;
  };
  timestamp?: Date;
  error?: string;
  code?: string;
}>;
export function getPoolMetrics(): {
  totalConnections: number;
  idleConnections: number;
  waitingClients: number;
  maxConnections: number;
  minConnections: number;
  totalErrors: number;
};
export function shutdown(): Promise<void>;