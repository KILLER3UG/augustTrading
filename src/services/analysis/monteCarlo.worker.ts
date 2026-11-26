/**
 * Monte Carlo Web Worker
 * Runs CPU-intensive simulations off the main thread to prevent UI jank.
 *
 * Usage from main thread:
 *   const worker = new Worker(new URL('./monteCarlo.worker.ts', import.meta.url), { type: 'module' });
 *   worker.postMessage({ type: 'runSimulation', config });
 *   worker.onmessage = (e) => { ... e.data.result ... };
 */

import { runSimulation, calculateRuinRisk } from './MonteCarloService';
import type { SimulationConfig, MonteCarloResult } from './MonteCarloService';

interface RunSimulationMessage {
  type: 'runSimulation';
  id: string;
  config: SimulationConfig;
}

interface CalculateRuinRiskMessage {
  type: 'calculateRuinRisk';
  id: string;
  accountBalance: number;
  positionSize: number;
  leverage: number;
  monteCarloResult: MonteCarloResult;
  /** Optional explicit seed. The main thread and this worker both fall back
   *  to deriveRuinRiskSeed(inputs) inside calculateRuinRisk, so the loop is
   *  deterministic and the two paths agree even when no seed is sent. */
  seed?: number;
}

type WorkerMessage = RunSimulationMessage | CalculateRuinRiskMessage;

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  try {
    if (msg.type === 'runSimulation') {
      const result = runSimulation(msg.config);
      self.postMessage({ type: 'result', id: msg.id, result });
    } else if (msg.type === 'calculateRuinRisk') {
      const result = calculateRuinRisk(
        msg.accountBalance,
        msg.positionSize,
        msg.leverage,
        msg.monteCarloResult,
        msg.seed
      );
      self.postMessage({ type: 'result', id: msg.id, result });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: msg.id,
      error: error instanceof Error ? error.message : 'Unknown worker error',
    });
  }
};
