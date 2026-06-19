/**
 * agent.ts — Permanent agent runtime.
 *
 * An agent is a session with a serializable snapshot and a scheduling contract.
 * Any worker that can satisfy the agent's tool requirements can:
 *   1. Pull the agent's snapshot from the store
 *   2. Load its gaps
 *   3. Solve the planning graph
 *   4. Execute until the next long wait
 *   5. Upload the snapshot back to the store
 *   6. Push the scheduling criteria to the server
 *
 * The agent isn't special. It's a user session that outlives its runtime.
 * Workers are interchangeable — whoever can schedule the agent's work does.
 */

import { OfficeSpaceClient, type ClientEvent } from '@console-one/sequenceutils/transport';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface AgentConfig {
  /** Agent identity. */
  agentId: string;
  /** Server URL. */
  serverUrl: string;
  /** Local data directory for snapshots. */
  dataDir: string;
  /** Tools this worker provides to the agent. */
  tools?: Record<string, Function>;
  /** Max execution time before yielding (ms). Default: 30000. */
  maxExecutionMs?: number;
  /** Scheduling criteria — pushed to server after execution. */
  schedule?: {
    /** Cron-like interval or 'once'. */
    interval?: string;
    /** Minimum delay before next run (ms). */
    minDelayMs?: number;
    /** Run again only if gaps remain. */
    runWhileGaps?: boolean;
  };
}

export interface AgentRunResult {
  /** Gaps remaining after this execution cycle. */
  remainingGaps: number;
  /** Number of gaps filled during this run. */
  gapsFilled: number;
  /** Whether the agent should be re-scheduled. */
  reschedule: boolean;
  /** Suggested next run time (epoch ms). */
  nextRunAt?: number;
  /** Reason for stopping. */
  stopReason: 'complete' | 'timeout' | 'longwait' | 'error';
}

export class PermanentAgent {
  private client: OfficeSpaceClient;
  private config: AgentConfig;
  private startTime = 0;

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new OfficeSpaceClient({
      dataDir: join(config.dataDir, config.agentId),
      serverUrl: config.serverUrl,
      user: config.agentId,
      env: 'agent',
      heartbeatMs: 10000,
    });
  }

  /**
   * Run the agent for one execution cycle.
   *
   * 1. Boot from snapshot (local or pulled from store)
   * 2. Connect to server, sync state
   * 3. Read gaps
   * 4. For each gap, check if local tools can fill it
   * 5. Fill gaps using tools
   * 6. Stop when: no more fillable gaps, timeout, or long-wait detected
   * 7. Save snapshot
   * 8. Push scheduling criteria to server
   * 9. Disconnect
   */
  async run(): Promise<AgentRunResult> {
    this.startTime = Date.now();
    const maxMs = this.config.maxExecutionMs ?? 30000;
    let gapsFilled = 0;
    let stopReason: AgentRunResult['stopReason'] = 'complete';

    try {
      // Boot and connect
      await this.client.boot();

      // Register local tools
      if (this.config.tools) {
        for (const [name, impl] of Object.entries(this.config.tools)) {
          this.client.mount(`tool ${name}`);
          // The impl is registered on the local sequence
          (this.client as any).seq?.mount('tool', name, impl);
        }
      }

      // Execution loop: fill gaps until done, timeout, or long-wait
      let iterations = 0;
      const maxIterations = 100;

      while (iterations < maxIterations) {
        iterations++;

        // Check timeout
        if (Date.now() - this.startTime > maxMs) {
          stopReason = 'timeout';
          break;
        }

        // Get current gaps
        const gaps = this.client.gaps();
        if (gaps.length === 0) {
          stopReason = 'complete';
          break;
        }

        // Try to fill gaps with local tools
        let filledThisRound = false;
        for (const gap of gaps) {
          if (gap.tools.length === 0) continue;

          // Check if any of this gap's tools are locally available
          for (const capId of gap.tools) {
            if (this.config.tools && capId in this.config.tools) {
              try {
                const impl = this.config.tools[capId];
                const result = impl(this.client.get(gap.path));
                if (result !== undefined) {
                  this.client.mount(`${gap.path} = ${JSON.stringify(result)}`);
                  gapsFilled++;
                  filledThisRound = true;
                }
              } catch {}
              break;
            }
          }
        }

        // If no gaps were filled, we're stuck — long wait
        if (!filledThisRound) {
          stopReason = 'longwait';
          break;
        }
      }
    } catch (e: any) {
      stopReason = 'error';
      // Report violation
      this.client.reportViolation(
        `agents.${this.config.agentId}`,
        e.message,
        this.config.schedule?.minDelayMs,
      );
    }

    // Calculate remaining gaps
    const remainingGaps = this.client.gaps().length;

    // Push scheduling criteria to server
    const reschedule = stopReason !== 'complete' ||
      (this.config.schedule?.runWhileGaps && remainingGaps > 0);

    const nextRunAt = reschedule
      ? Date.now() + (this.config.schedule?.minDelayMs ?? 60000)
      : undefined;

    // Mount scheduling state on server
    this.client.mount([
      `agents.${this.config.agentId}.lastRun = ${Date.now()}`,
      `agents.${this.config.agentId}.stopReason = "${stopReason}"`,
      `agents.${this.config.agentId}.gapsFilled = ${gapsFilled}`,
      `agents.${this.config.agentId}.remainingGaps = ${remainingGaps}`,
      reschedule ? `agents.${this.config.agentId}.nextRunAt = ${nextRunAt}` : '',
      reschedule ? `agents.${this.config.agentId}.reschedule = true` : `agents.${this.config.agentId}.reschedule = false`,
    ].filter(Boolean).join('\n'));

    // Disconnect — snapshot already saved by client
    this.client.shutdown();

    return { remainingGaps, gapsFilled, reschedule, nextRunAt, stopReason };
  }

  /** Pull agent snapshot from remote store into local data dir. */
  static async pull(agentId: string, storeUrl: string, dataDir: string): Promise<void> {
    // In production this would fetch from the server's store API
    // For now, the OfficeSpaceClient's local persistence handles it
    const agentDir = join(dataDir, agentId);
    if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  }

  /** Push agent snapshot from local data dir to remote store. */
  static async push(agentId: string, storeUrl: string, dataDir: string): Promise<void> {
    // In production this would upload to the server's store API
    // The snapshot at dataDir/agentId/snapshot.json is already current
  }
}
